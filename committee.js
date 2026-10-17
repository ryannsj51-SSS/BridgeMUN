import {
  addDoc,
  auth,
  db,
  ensureAnonymousUser,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "./firebase.js";

// Shared committee data and logic (topics, phases, vote math, and the
// Firestore helpers for committee/state) -- also used by chair.js, see
// committee-data.js.
import {
  COMMITTEE_TOPICS,
  COMMITTEE_COUNTRIES,
  getTopic,
  randomTopicId,
  COMMITTEE_PHASES,
  SETUP_PHASE_INDEX,
  OPENING_SPEECHES_PHASE_INDEX,
  MOTION_RAISING_PHASE_INDEX,
  MOTION_VOTING_PHASE_INDEX,
  CAUCUS_DEBATE_PHASE_INDEX,
  RESOLUTION_VOTE_PHASE_INDEX,
  CONFERENCE_RESULTS_PHASE_INDEX,
  MOTION_TYPES,
  SETUP_STAGE,
  conferenceWelcomeMessage,
  findNextHumanSpeakerIndex,
  VOTE_THRESHOLD,
  VOTE_CHOICE_LABELS,
  VOTE_CHOICE_BUTTON_CLASSES,
  isFinalSigningVote,
  voteOutcome,
  committeeStateRef,
  latestCommitteeState,
  setLatestCommitteeState,
  committeeResolutionRef,
  RESOLUTION_MAX_LENGTH,
  RESOLUTION_EDITABLE_START_INDEX,
  isResolutionEditablePhase,
  initialVotesForPhase,
  logActivity,
  ensureCommitteeState,
  joinSessionByCode,
  getCommitteeMessagesCollection,
  formatDelegateLabel,
  castVote,
  castMotion,
  requestYield,
  lockRosterAndStart,
  syncAiAutoAdvance,
  markReadyToProceed,
} from "./committee-data.js";

// Every delegate session is scoped to one meeting's 6-digit code, shared
// by the chair -- see join-code.html, where a visitor types it in before
// ever reaching this page. A direct visit here with no saved code (or a
// code the chair has since retired by resetting the session) sends them
// back there instead of showing a broken page. Top-level await is safe
// here because this script loads as an ES module (type="module" in
// delegate.html).
const savedSessionCode = localStorage.getItem("mun-session-code");
const joinedSession = savedSessionCode ? await joinSessionByCode(savedSessionCode) : false;
if (!joinedSession) {
  localStorage.removeItem("mun-session-code");
  window.location.href = "join-code.html";
  throw new Error("No active meeting code -- redirecting to the code entry page.");
}

// Shows the meeting code right at the top of the page -- see the
// session-code-banner markup in delegate.html, just under the
// committee title -- so a delegate can see and share it well before
// the "Start Conference" card further down. savedSessionCode is
// already known to be this visitor's real, joined code by this point
// (the redirect above already ruled out anything else).
document.getElementById("delegate-session-code").textContent = savedSessionCode;

// Draft-resolution textarea UI state -- local to this page (chair.js has
// no textarea to keep in sync), unlike the shared data above.
let latestResolutionText = "";
let resolutionSaveTimeoutId = null;

// Which country (if any) THIS visitor was assigned to represent this
// session -- undefined until claimDelegateCountry() below resolves,
// then either a country name or null (every human seat was already
// taken, so this visitor only gets to watch).
let myAssignedCountry;

// Gives this delegate their own country for the session -- picked at
// random from whichever of the five human-run countries nobody else has
// claimed yet. Sticks across reloads: it always checks this visitor's
// own uid in delegateAssignments first, so refreshing the page never
// reassigns them to a different country. Returns null if every human
// seat is already taken, which the caller shows as a read-only observer
// view instead of blocking the page entirely.
async function claimDelegateCountry() {
  const user = await ensureAnonymousUser();
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      // joinSessionByCode() already confirmed this document exists
      // before this page ever loaded -- this is just a safety net in
      // case the conference's owner resets it in between.
      return null;
    }

    const data = snapshot.data();
    const assignments = { ...(data.delegateAssignments ?? {}) };

    // Already assigned (an earlier visit, or earlier this same page
    // load) -- keep the same country instead of reassigning.
    if (assignments[user.uid]) {
      return assignments[user.uid];
    }

    const humanCountries = COMMITTEE_COUNTRIES.filter((country) => data.delegateRoles[country] === "human");
    const takenCountries = new Set(Object.values(assignments));
    const availableCountries = humanCountries.filter((country) => !takenCountries.has(country));

    if (availableCountries.length === 0) {
      return null;
    }

    const claimedCountry = availableCountries[Math.floor(Math.random() * availableCountries.length)];
    transaction.update(committeeStateRef, {
      [`delegateAssignments.${user.uid}`]: claimedCountry,
      updatedAt: serverTimestamp(),
    });
    return claimedCountry;
  });
}

// Keeps the observer banner, the "Representing" display, and whether
// the message form can be used at all in sync with myAssignedCountry.
// Safe to call before the assignment has resolved (undefined) and again
// any time afterward -- it just reflects whatever the latest value is.
function applyDelegateIdentityToUI() {
  observerNoticeEl.hidden = myAssignedCountry !== null;

  if (myAssignedCountry === undefined) {
    myCountryDisplayEl.textContent = "Joining the committee…";
  } else if (myAssignedCountry === null) {
    myCountryDisplayEl.textContent = "Observer (no seat assigned)";
  } else {
    myCountryDisplayEl.textContent = myAssignedCountry;
  }

  // Observers (and visitors whose assignment hasn't resolved yet)
  // cannot send discussion messages at all.
  const canMessage = Boolean(myAssignedCountry);
  messageForm.querySelector("textarea").disabled = !canMessage;
  messageForm.querySelector("button").disabled = !canMessage;
}

const discussionFeed = document.getElementById("discussion-feed");
const delegateList = document.getElementById("delegate-list");
const userMessageFeed = document.getElementById("user-message-feed");
const messageForm = document.getElementById("message-form");
const messageStatus = document.getElementById("message-status");
const observerNoticeEl = document.getElementById("observer-notice");
const myCountryDisplayEl = document.getElementById("my-country-display");

// The "Start Conference" card -- lets a lone delegate start the
// conference themselves if nobody else ever joins with the meeting
// code (see renderCommitteeState below for how these three track
// rosterLocked/chairIsAi, and lockRosterAndStart/syncAiAutoAdvance in
// committee-data.js for what actually runs once they do).
const delegateStartButton = document.getElementById("delegate-start-button");
const delegateStartStatusEl = document.getElementById("delegate-start-status");
const delegateAiChairBadgeEl = document.getElementById("delegate-ai-chair-badge");

// Controls for picking which delegate, voice gender, and accent setting to
// use before generating that delegate's AI speech as real audio.
const speechCountrySelect = document.getElementById("speech-country");
const speechGenderSelect = document.getElementById("speech-gender");
const speechAccentCheckbox = document.getElementById("speech-accent");
const speechButton = document.getElementById("ai-speech-button");
const speechStatus = document.getElementById("speech-status");

// Elements for the committee procedure / voting panel.
const phaseStepEl = document.getElementById("phase-step");
const phaseNameEl = document.getElementById("phase-name");
const voteQuestionEl = document.getElementById("vote-question");
const voteStatusChartEl = document.getElementById("vote-status-chart");
const voteRowsEl = document.getElementById("vote-rows");
const voteStatusEl = document.getElementById("vote-status");
const resetVoteButton = document.getElementById("reset-vote-button");
const proceedButton = document.getElementById("proceed-button");
const proceedStatusEl = document.getElementById("proceed-status");
const conferenceWelcomeBannerEl = document.getElementById("conference-welcome-banner");

// Elements for the Motion Raising panel -- any delegate can propose one
// of the two motions below; the chair opens the vote on whichever one
// is currently raised (see chair.js).
const motionPickerEl = document.getElementById("motion-picker");
const motionButtons = motionPickerEl ? [...motionPickerEl.querySelectorAll(".motion-button")] : [];

// Elements for the Caucus / Debate speaking-order panel.
const yieldCard = document.getElementById("yield-card");
const yieldOrderListEl = document.getElementById("yield-order-list");
const yieldForm = document.getElementById("yield-form");
const yieldMessageInput = document.getElementById("yield-message");
const yieldStatusEl = document.getElementById("yield-status");

// Elements for the shared Draft Resolution document.
const resolutionCard = document.getElementById("resolution-card");
const resolutionHintEl = document.getElementById("resolution-hint");
const resolutionTextarea = document.getElementById("resolution-textarea");
const resolutionStatusEl = document.getElementById("resolution-status");

// The committee topic banner at the top of the page.
const committeeTopicLabelEl = document.getElementById("committee-topic-label");
const committeeTopicTextEl = document.getElementById("committee-topic-text");

// Elements for the Roll Call Results bar chart (the presence check outcome from Conference Setup).
const rollCallCard = document.getElementById("roll-call-card");
const rollCallChart = document.getElementById("roll-call-chart");

// Elements for the always-visible conference timeline table and the
// pop-up that announces a phase change.
const timelineBody = document.getElementById("timeline-body");
const phaseToast = document.getElementById("phase-toast");
let phaseToastTimeoutId = null;
let lastAnnouncedPhaseIndex = null;


// Shows a brief pop-up announcing the phase the committee just entered.
// Re-showing it (a second phase change while one is still visible) just
// restarts the fade timer instead of stacking multiple pop-ups.
function showPhaseToast(message) {
  phaseToast.textContent = message;
  phaseToast.classList.add("phase-toast-visible");

  if (phaseToastTimeoutId) {
    clearTimeout(phaseToastTimeoutId);
  }
  phaseToastTimeoutId = setTimeout(() => {
    phaseToast.classList.remove("phase-toast-visible");
  }, 4000);
}

// Renders the always-present timeline table: every phase in order, with a
// checkmark for each one already completed, "In Progress" for the current
// one, and blank for anything still ahead.
function renderTimelineTable(phaseIndex, sessionComplete) {
  timelineBody.replaceChildren(
    ...COMMITTEE_PHASES.map((phaseName, index) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const statusCell = document.createElement("td");

      nameCell.textContent = phaseName;
      statusCell.className = "timeline-status";

      const isDone = index < phaseIndex || (index === phaseIndex && sessionComplete);
      const isCurrent = index === phaseIndex && !sessionComplete;

      if (isDone) {
        statusCell.textContent = "✓ Done";
        statusCell.classList.add("timeline-done");
      } else if (isCurrent) {
        statusCell.textContent = "In Progress";
        statusCell.classList.add("timeline-active");
        row.className = "timeline-current";
      }

      row.append(nameCell, statusCell);
      return row;
    }),
  );
}

// Clears every vote for the current phase back to blank (AI Delegates
// immediately auto-vote again) so delegates can retry a failed vote.
// Only ever shown for the final Sign/Not Sign/Abstain vote -- a failed
// Motion Voting vote already reverts to Motion Raising automatically
// (see castVote), so there's nothing left here to reset for that one.
async function resetCurrentVote() {
  await ensureAnonymousUser();
  const phaseName = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    if (!isFinalSigningVote(data.phaseIndex, data.subStage)) {
      return null;
    }
    transaction.update(committeeStateRef, {
      votes: initialVotesForPhase(data.delegateRoles, data.phaseIndex, data.subStage),
      updatedAt: serverTimestamp(),
    });
    return COMMITTEE_PHASES[data.phaseIndex];
  });

  if (phaseName) {
    logActivity("vote_reset", null, `The vote for ${phaseName} was reset after it failed.`);
  }
}

// Saves the shared draft resolution a short moment after the delegate
// stops typing -- debounced so we're not writing to Firestore on every
// single keystroke. Each new keystroke restarts the delay.
function scheduleResolutionSave() {
  resolutionStatusEl.textContent = "Saving\u2026";
  if (resolutionSaveTimeoutId) {
    clearTimeout(resolutionSaveTimeoutId);
  }
  resolutionSaveTimeoutId = setTimeout(async () => {
    // The phase (or subStage) can change while this delay is still
    // counting down (for example, the chair opens the final vote right
    // after someone's last keystroke) -- re-check here, right before
    // writing, instead of relying only on the disabled textarea, so a
    // save that's no longer allowed doesn't reach Firestore and come
    // back looking like a connection problem.
    if (!isResolutionEditablePhase(latestCommitteeState?.phaseIndex, latestCommitteeState?.subStage) || !myAssignedCountry) {
      resolutionStatusEl.textContent = !myAssignedCountry
        ? "Locked -- observers can't edit the draft resolution."
        : "Locked -- the phase changed before this was saved.";
      return;
    }
    try {
      await ensureAnonymousUser();
      const text = resolutionTextarea.value.slice(0, RESOLUTION_MAX_LENGTH);
      await setDoc(committeeResolutionRef, { text, updatedAt: serverTimestamp() });
      latestResolutionText = text;
      resolutionStatusEl.textContent = "Saved.";
    } catch (error) {
      console.error("Unable to save the draft resolution:", error);
      resolutionStatusEl.textContent = "Could not save -- check your connection and try again.";
    }
  }, 800);
}

// Shows, hides, and locks the Draft Resolution card based on the current
// phase: hidden before Caucus / Debate, editable through Caucus / Debate
// and the "drafting" half of Resolution / Final Vote, then visible but
// read-only once the final vote actually opens (and for the rest of the
// session after that) so delegates can review exactly what they're
// voting to sign.
function renderResolutionCard(phaseIndex, subStage) {
  const editable = isResolutionEditablePhase(phaseIndex, subStage) && Boolean(myAssignedCountry);
  const canView = phaseIndex >= RESOLUTION_EDITABLE_START_INDEX;

  resolutionCard.hidden = !canView;
  if (!canView) {
    return;
  }

  resolutionTextarea.disabled = !editable;

  // Only overwrite the textarea's value from the latest synced text
  // when the delegate isn't actively typing in it -- otherwise someone
  // else's save could clobber this delegate's own keystrokes mid-edit.
  if (document.activeElement !== resolutionTextarea) {
    resolutionTextarea.value = latestResolutionText;
  }

  if (editable) {
    resolutionHintEl.textContent =
      "Every delegate editing this page writes here together -- changes save automatically and appear live for everyone.";
  } else if (isResolutionEditablePhase(phaseIndex, subStage)) {
    // Locked for THIS visitor specifically -- the phase itself still
    // allows editing, but they're an observer, not an assigned delegate.
    resolutionHintEl.textContent = "You're watching as an observer, so this is locked for you -- the committee's delegates can still edit it.";
  } else {
    resolutionHintEl.textContent = "This is the resolution delegates are voting to sign -- it's locked and can no longer be edited.";
  }
}

// Shows the Yield Time speaking-order panel: who's already yielded,
// who's up next, and -- only for whichever delegate currently has the
// floor -- a Yield button. Hidden entirely outside Yield Time.
// Spells out a 1-based position as "1st", "2nd", "3rd", "4th", etc. --
// only ever needs to handle a handful of waiting delegates, so this
// doesn't bother with the 11th/12th/13th exceptions real ordinals need.
function ordinal(n) {
  const suffixes = { 1: "st", 2: "nd", 3: "rd" };
  return `${n}${suffixes[n] ?? "th"}`;
}

// The Queue Order panel: who's speaking right now, who's already
// yielded, and -- for every delegate still waiting -- exactly which
// position they're in, so nobody has to guess how much longer until
// their turn. Only shown during Caucus / Debate.
function renderYieldCard(phaseIndex, delegateRoles, currentSpeakerIndex, pendingYieldRequest, delegateNames) {
  const onCaucusDebate = phaseIndex === CAUCUS_DEBATE_PHASE_INDEX;
  yieldCard.hidden = !onCaucusDebate;
  if (!onCaucusDebate) {
    return;
  }

  const allDone = currentSpeakerIndex >= COMMITTEE_COUNTRIES.length;
  const currentSpeaker = allDone ? null : COMMITTEE_COUNTRIES[currentSpeakerIndex];

  // Tracked while building the list below so the summary line underneath
  // can call out THIS visitor's own status without a second pass over
  // every country.
  let queuePosition = 0;
  let myQueuePosition = null;
  let myStatus = null; // "speaking" | "waiting" | "done" | null

  yieldOrderListEl.replaceChildren(
    ...COMMITTEE_COUNTRIES.map((country, index) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      const status = document.createElement("span");

      row.className = "yield-order-row";
      name.textContent = formatDelegateLabel(country, delegateNames);
      status.className = "yield-order-status";

      if (delegateRoles[country] === "ai") {
        status.textContent = "AI Delegate";
      } else if (allDone || index < currentSpeakerIndex) {
        status.textContent = "Yielded to the Chair";
        if (country === myAssignedCountry) {
          myStatus = "done";
        }
      } else if (country === currentSpeaker) {
        status.textContent = "Speaking now";
        row.classList.add("yield-order-current");
        if (country === myAssignedCountry) {
          myStatus = "speaking";
        }
      } else {
        queuePosition += 1;
        status.textContent = `Position ${queuePosition} in queue`;
        if (country === myAssignedCountry) {
          myStatus = "waiting";
          myQueuePosition = queuePosition;
        }
      }

      if (country === myAssignedCountry) {
        row.classList.add("yield-order-mine");
      }

      row.append(name, status);
      return row;
    }),
  );

  const isMyTurn = myStatus === "speaking";
  // A request already sent for THIS visitor's own turn -- the form
  // stays visible (so they can see what they typed) but locked, since
  // only the Chair approving it can actually move the floor on now.
  const myRequestPending = Boolean(pendingYieldRequest) && pendingYieldRequest.country === myAssignedCountry;

  yieldForm.hidden = !isMyTurn;
  yieldMessageInput.disabled = myRequestPending;
  yieldForm.querySelector("button").disabled = myRequestPending;
  if (!myRequestPending && document.activeElement !== yieldMessageInput) {
    yieldMessageInput.value = "I will yield the rest of my time to the Chair.";
  }

  if (allDone) {
    yieldStatusEl.textContent = "Every delegate has had the floor -- the chair will move the committee on when ready.";
  } else if (myRequestPending) {
    yieldStatusEl.textContent = "Your yield request was sent -- waiting for the Chair to approve it.";
  } else if (isMyTurn) {
    yieldStatusEl.textContent = "You have the floor -- send a yield request to the Chair when you're ready to give it up.";
  } else if (myStatus === "waiting") {
    yieldStatusEl.textContent =
      myQueuePosition === 1
        ? `You're next, right after ${currentSpeaker} yields.`
        : `You're ${ordinal(myQueuePosition)} in the queue, after ${currentSpeaker}.`;
  } else if (myStatus === "done") {
    yieldStatusEl.textContent = "You've already yielded your time to the Chair.";
  } else if (currentSpeaker) {
    yieldStatusEl.textContent =
      pendingYieldRequest?.country === currentSpeaker
        ? `${currentSpeaker} has asked to yield -- waiting for the Chair to approve it.`
        : `Waiting for ${currentSpeaker} to yield.`;
  } else {
    yieldStatusEl.textContent = "";
  }
}

// Shows or hides the Proceed button + its status line, for whichever
// of the four non-voting phases (Opening Speeches, Motion Raising once
// a motion is raised, Caucus / Debate, Resolution Drafting) just
// rendered right before calling this -- every other phase calls this
// with phaseQualifies=false, which hides both. Only ever shown to a
// delegate actually representing a country (observers have nothing to
// click), and only once there's actually something collecting
// responses: an AI-run conference (chairIsAi) always collects them,
// since the AI-auto-advance driver in committee-data.js is waiting on
// them; a human-chaired conference only does once the Chair opens a
// readiness check (see openReadinessCheck in committee-data.js and the
// matching button in chair.js) -- clicking Proceed there never
// advances anything by itself, it just shows up on the Chair's own
// dashboard.
function updateProceedUI(phaseQualifies, delegateRoles, readyCountries, chairIsAi, readyCheckOpen) {
  const showPanel = phaseQualifies && (chairIsAi || readyCheckOpen) && Boolean(myAssignedCountry);
  if (!showPanel) {
    proceedButton.hidden = true;
    proceedStatusEl.hidden = true;
    return;
  }

  const ready = readyCountries ?? {};
  const alreadyReady = ready[myAssignedCountry] === true;
  const notReadyCountries = COMMITTEE_COUNTRIES.filter(
    (country) => delegateRoles[country] === "human" && !ready[country],
  );

  proceedButton.hidden = alreadyReady;
  proceedStatusEl.hidden = false;

  if (alreadyReady) {
    proceedStatusEl.textContent =
      notReadyCountries.length > 0
        ? `You're ready. Waiting on: ${notReadyCountries.join(", ")}.`
        : chairIsAi
          ? "Everyone's ready -- moving on shortly."
          : "Everyone's ready -- waiting for the Chair to move things along.";
  } else {
    proceedStatusEl.textContent = chairIsAi
      ? "Click Proceed once you're ready to move on."
      : "The Chair opened a readiness check -- click Proceed once you're ready to move on.";
  }
}

function renderCommitteeState(data) {
  const {
    phaseIndex,
    delegateRoles,
    votes,
    rollCallVotes,
    topicId,
    currentSpeakerIndex,
    raisedMotion,
    subStage,
    pendingYieldRequest,
    setupStage,
    conferenceNumber,
    delegateNames,
    rosterLocked,
    chairIsAi,
    readyCountries,
    readyCheckOpen,
  } = data;
  const phaseName = COMMITTEE_PHASES[phaseIndex];
  const sessionComplete = phaseIndex === CONFERENCE_RESULTS_PHASE_INDEX;
  const currentTopic = getTopic(topicId);

  // The "Start Conference" card: once clicked, the button disappears
  // for good and the status line explains what happened; the AI-run
  // badge only ever shows once chairIsAi is also true. See
  // lockRosterAndStart in committee-data.js for what set these fields,
  // and chair.html's version of this same pattern.
  delegateStartButton.hidden = rosterLocked === true;
  if (rosterLocked) {
    delegateStartStatusEl.textContent = chairIsAi
      ? "Started -- the AI is running the Chair's side of things too."
      : "Started -- registration is closed and every unclaimed seat is now an AI Delegate.";
  }
  delegateAiChairBadgeEl.hidden = !(rosterLocked && chairIsAi);

  // Keeps the AI-auto-advance timer running exactly while it should be
  // -- shared with chair.js so the same loop runs no matter which page
  // happens to be open (see syncAiAutoAdvance in committee-data.js).
  syncAiAutoAdvance(data);

  // Hidden by default -- whichever of the four non-voting phases
  // below actually applies overrides this with phaseQualifies=true
  // right before it returns.
  updateProceedUI(false, delegateRoles, readyCountries, chairIsAi, readyCheckOpen);

  if (lastAnnouncedPhaseIndex !== null && phaseIndex !== lastAnnouncedPhaseIndex) {
    showPhaseToast(`Now entering: ${phaseName}`);
  }
  lastAnnouncedPhaseIndex = phaseIndex;

  renderTimelineTable(phaseIndex, sessionComplete);
  renderRollCallChart(rollCallVotes);
  renderYieldCard(phaseIndex, delegateRoles, currentSpeakerIndex ?? 0, pendingYieldRequest, data.delegateNames);
  renderResolutionCard(phaseIndex, subStage);
  applyDelegateIdentityToUI();

  // The committee topic banner at the top of the page.
  if (currentTopic) {
    committeeTopicLabelEl.textContent = "Topic";
    committeeTopicTextEl.textContent = `${currentTopic.name} \u2014 ${currentTopic.description}`;
  }

  phaseStepEl.textContent = `Phase ${phaseIndex + 1} of ${COMMITTEE_PHASES.length}`;
  phaseNameEl.textContent = phaseName;

  // The welcome message only ever appears once the Chair has clicked
  // "Start Conference & Give Instructions" and only while the
  // goal-agreement poll it announces is still part of Conference
  // Setup -- hidden the rest of the time.
  const showWelcomeBanner = phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.GOAL_POLL && conferenceNumber != null;
  conferenceWelcomeBannerEl.hidden = !showWelcomeBanner;
  if (showWelcomeBanner) {
    conferenceWelcomeBannerEl.textContent = conferenceWelcomeMessage(conferenceNumber);
  }

  // Delegate list, with each country's role for this committee session.
  delegateList.replaceChildren(
    ...COMMITTEE_COUNTRIES.map((country) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      const role = document.createElement("span");

      item.className = "delegate";
      role.className = "role";
      name.textContent = formatDelegateLabel(country, delegateNames);
      role.textContent = delegateRoles[country] === "ai" ? "AI Delegate" : "Human";

      item.append(name, role);
      return item;
    }),
  );

  // The AI-speech dropdown only ever lists this session's AI Delegates.
  speechCountrySelect.replaceChildren(
    ...COMMITTEE_COUNTRIES.filter((country) => delegateRoles[country] === "ai").map((country) => {
      const option = document.createElement("option");
      option.value = country;
      option.textContent = country;
      return option;
    }),
  );

  // Only three phases ever show the vote panel (chart + per-country
  // rows): Conference Setup's presence check, Motion Voting, and the
  // final Sign/Not Sign/Abstain vote. Every other phase -- Opening
  // Speeches, Motion Raising, Caucus / Debate, and the "drafting" half
  // of Resolution / Final Vote -- hides it and shows its own status
  // message instead; the Chair manually moves things along from those
  // phases (see chair.js).
  const onMotionRaising = phaseIndex === MOTION_RAISING_PHASE_INDEX;
  motionPickerEl.hidden = !onMotionRaising;
  motionButtons.forEach((button) => {
    button.disabled = !myAssignedCountry;
  });

  if (sessionComplete) {
    const finalOutcome = voteOutcome(votes, "sign");
    voteQuestionEl.textContent = "Conference Results";
    voteStatusChartEl.replaceChildren();
    voteRowsEl.replaceChildren();
    voteStatusEl.textContent =
      `The session is complete. Topic: ${currentTopic ? currentTopic.name : "none"}. ` +
      (finalOutcome === "passed"
        ? "The resolution was signed and adopted by majority vote."
        : "The final vote did not reach a majority -- the resolution was not adopted.");
    resetVoteButton.hidden = true;
    return;
  }

  if (phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.AWAITING_START) {
    voteQuestionEl.textContent = "Conference Setup";
    voteStatusChartEl.replaceChildren();
    voteRowsEl.replaceChildren();
    voteStatusEl.textContent = "Presence confirmed -- waiting for the Chair to start the conference.";
    resetVoteButton.hidden = true;
    return;
  }

  if (phaseIndex === OPENING_SPEECHES_PHASE_INDEX) {
    voteQuestionEl.textContent = "Opening Speeches";
    voteStatusChartEl.replaceChildren();
    voteRowsEl.replaceChildren();
    voteStatusEl.textContent =
      "Delegates are giving their opening speeches -- the Chair will move on to Motion Raising when ready.";
    resetVoteButton.hidden = true;
    updateProceedUI(true, delegateRoles, readyCountries, chairIsAi, readyCheckOpen);
    return;
  }

  if (onMotionRaising) {
    voteQuestionEl.textContent = "Motion Raising";
    voteStatusChartEl.replaceChildren();
    voteRowsEl.replaceChildren();
    voteStatusEl.textContent = raisedMotion
      ? `${MOTION_TYPES[raisedMotion.type] ?? raisedMotion.type} raised by ${raisedMotion.raisedBy} -- waiting for the Chair to open the vote.`
      : "Any delegate can propose a motion above for what the committee does next.";
    resetVoteButton.hidden = true;
    // Nothing to be "ready" for until a motion actually exists to vote
    // on -- raising one isn't gated (see the AI-auto-advance driver in
    // committee-data.js), only opening the vote on it is.
    updateProceedUI(Boolean(raisedMotion), delegateRoles, readyCountries, chairIsAi, readyCheckOpen);
    return;
  }

  if (phaseIndex === CAUCUS_DEBATE_PHASE_INDEX) {
    voteQuestionEl.textContent = raisedMotion
      ? `Caucus / Debate \u2014 debating under: ${MOTION_TYPES[raisedMotion.type] ?? raisedMotion.type}`
      : "Caucus / Debate";
    voteStatusChartEl.replaceChildren();
    voteRowsEl.replaceChildren();
    voteStatusEl.textContent =
      "See the Queue Order panel to yield your speaking time -- the Chair will move the committee on to Resolution / Final Vote when ready.";
    resetVoteButton.hidden = true;
    updateProceedUI(true, delegateRoles, readyCountries, chairIsAi, readyCheckOpen);
    return;
  }

  if (phaseIndex === RESOLUTION_VOTE_PHASE_INDEX && subStage === "drafting") {
    voteQuestionEl.textContent = "Resolution / Final Vote \u2014 Drafting";
    voteStatusChartEl.replaceChildren();
    voteRowsEl.replaceChildren();
    voteStatusEl.textContent = "Draft your resolution below -- the Chair will open the final vote when it's ready.";
    resetVoteButton.hidden = true;
    updateProceedUI(true, delegateRoles, readyCountries, chairIsAi, readyCheckOpen);
    return;
  }

  // From here on, this phase actually holds a vote: Conference Setup's
  // presence check, Motion Voting, or the final Sign/Not Sign/Abstain
  // vote inside Resolution / Final Vote.
  const passingValue = isFinalSigningVote(phaseIndex, subStage) ? "sign" : "yes";
  const choiceOptions = isFinalSigningVote(phaseIndex, subStage) ? ["sign", "not_sign", "abstain"] : ["yes", "no"];
  const aiAutoChoice = isFinalSigningVote(phaseIndex, subStage) ? "sign" : "yes";
  const rawOutcome = voteOutcome(votes, passingValue);
  // In an AI-run conference, outside Conference Setup, the AI-majority
  // bloc alone almost always already reaches the threshold the instant
  // the phase opens -- without this, this delegate's own vote buttons
  // below would never even appear, since the branch right after this
  // treats a math-only "passed" as if the whole vote were already
  // over. castVote in committee-data.js already refuses to act on that
  // on the backend (see canActOnOutcome there); this keeps the display
  // honest about the same thing, by not treating the vote as decided
  // on screen until this delegate has actually cast their own.
  const humanStillNeedsToVote =
    chairIsAi && phaseIndex !== SETUP_PHASE_INDEX && myAssignedCountry && votes[myAssignedCountry] == null;
  const outcome = humanStillNeedsToVote ? "undecided" : rawOutcome;

  if (phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.GOAL_POLL) {
    voteQuestionEl.textContent = currentTopic
      ? `Goal Agreement Poll — do you agree with the chosen goal: ${currentTopic.name}?`
      : "Goal Agreement Poll — do you agree with the chosen goal?";
  } else if (phaseIndex === SETUP_PHASE_INDEX) {
    voteQuestionEl.textContent = "Vote to confirm presence:";
  } else if (phaseIndex === MOTION_VOTING_PHASE_INDEX) {
    voteQuestionEl.textContent = raisedMotion
      ? `Vote on: ${MOTION_TYPES[raisedMotion.type] ?? raisedMotion.type}`
      : "Vote on the raised motion:";
  } else {
    voteQuestionEl.textContent = "Vote on whether to sign this resolution into adoption:";
  }

  // Once a vote passes, delegates no longer get to see who voted for
  // what -- hide the live breakdown (chart + per-country rows) right
  // away and show a short "it passed" message instead. Firestore still
  // keeps every individual vote, and the chair's own dashboard
  // (chair.js) is untouched, so the chair can always see the full
  // breakdown.
  if (outcome === "passed") {
    voteStatusChartEl.replaceChildren();
    voteRowsEl.replaceChildren();
    voteStatusEl.textContent =
      phaseIndex === MOTION_VOTING_PHASE_INDEX
        ? "This motion passed -- moving on to Caucus / Debate."
        : phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.GOAL_POLL
          ? "Agreement reached -- moving on to Opening Speeches."
          : phaseIndex === SETUP_PHASE_INDEX
            ? "Presence confirmed -- waiting for the Chair to start the conference."
            : "This vote passed -- moving on to Conference Results.";
    resetVoteButton.hidden = true;
    return;
  }

  renderVoteStatusChart(choiceOptions, votes);

  voteRowsEl.replaceChildren(
    ...COMMITTEE_COUNTRIES.map((country) => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      const status = document.createElement("span");

      row.className = "vote-row";
      label.textContent = formatDelegateLabel(country, delegateNames);
      status.className = "vote-choice";

      if (delegateRoles[country] === "ai") {
        // During Conference Setup, an AI Delegate's automatic Yes reads
        // as "Present", matching real roll-call language.
        status.textContent =
          phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.ROLL_CALL
            ? "Present (AI, automatic)"
            : `${VOTE_CHOICE_LABELS[aiAutoChoice]} (AI, automatic)`;
        row.append(label, status);
        return row;
      }

      const currentVote = votes[country];
      if (currentVote) {
        status.textContent = `Voted: ${VOTE_CHOICE_LABELS[currentVote] ?? currentVote}`;
        row.append(label, status);
        return row;
      }

      // A delegate only ever casts their OWN country's vote -- every
      // other human seat (whether it's still unclaimed or belongs to
      // someone else) just shows its status here, with no buttons.
      if (country !== myAssignedCountry) {
        status.textContent = "Waiting to vote";
        row.append(label, status);
        return row;
      }

      const buttonGroup = document.createElement("div");
      buttonGroup.className = "vote-button-group";

      choiceOptions.forEach((choice) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `vote-button ${VOTE_CHOICE_BUTTON_CLASSES[choice]}`;
        button.textContent = VOTE_CHOICE_LABELS[choice];
        button.addEventListener("click", () => castVote(country, choice));
        buttonGroup.append(button);
      });

      row.append(label, buttonGroup);
      return row;
    }),
  );

  const passCount = COMMITTEE_COUNTRIES.filter((country) => votes[country] === passingValue).length;

  const onGoalPoll = phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.GOAL_POLL;

  if (outcome === "failed") {
    const failMessage =
      phaseIndex === MOTION_VOTING_PHASE_INDEX
        ? `This motion did not pass -- a majority (at least ${VOTE_THRESHOLD} of ${COMMITTEE_COUNTRIES.length}) is required, and that's no longer possible with the votes already cast. Returning to Motion Raising.`
        : onGoalPoll
          ? `This goal-agreement poll did not pass -- a majority (at least ${VOTE_THRESHOLD} of ${COMMITTEE_COUNTRIES.length}) is required, and that's no longer possible with the votes already cast. The Chair needs to choose a different topic to reopen the poll.`
          : isFinalSigningVote(phaseIndex, subStage)
            ? `This resolution did not pass -- a majority (at least ${VOTE_THRESHOLD} of ${COMMITTEE_COUNTRIES.length}) voting Sign is required, and that's no longer possible with the votes already cast. Reset the vote to try again.`
            : `This vote did not pass -- a majority (at least ${VOTE_THRESHOLD} of ${COMMITTEE_COUNTRIES.length}) is required, and that's no longer possible with the votes already cast. Reset the vote to try again.`;
    voteStatusEl.textContent = failMessage;
    // A failed Motion Voting vote already reverts to Motion Raising
    // automatically in the same write that caused the failure (see
    // castVote), and a failed goal-agreement poll recovers through the
    // Chair picking a new topic (see chooseTopic in chair.js) rather
    // than this button -- both stay hidden here, the rest fall back to
    // the existing Reset Vote button.
    resetVoteButton.hidden = phaseIndex === MOTION_VOTING_PHASE_INDEX || onGoalPoll;
  } else {
    const pendingMessage =
      onGoalPoll
        ? `${passCount} of ${COMMITTEE_COUNTRIES.length} delegates agree with the goal. A majority (at least ${VOTE_THRESHOLD}) is needed to proceed.`
        : phaseIndex === SETUP_PHASE_INDEX
          ? `${passCount} of ${COMMITTEE_COUNTRIES.length} delegates have confirmed presence. A majority (at least ${VOTE_THRESHOLD}) is needed to proceed.`
          : isFinalSigningVote(phaseIndex, subStage)
            ? `${passCount} of ${COMMITTEE_COUNTRIES.length} delegates have voted Sign. A majority (at least ${VOTE_THRESHOLD}) is needed to adopt the resolution.`
            : `${passCount} of ${COMMITTEE_COUNTRIES.length} delegates have voted Yes. A majority (at least ${VOTE_THRESHOLD}) is needed for this motion to pass.`;
    voteStatusEl.textContent = pendingMessage;
    resetVoteButton.hidden = true;
  }
}

// Renders a live bar chart of how the CURRENT vote is going: one bar per
// choice available in this phase (Yes/No, or Sign/Not Sign/Abstain),
// plus a "Not Yet Voted" bar for anyone still pending.
// Re-runs every time anyone's vote changes, so it's always up to date.
function renderVoteStatusChart(choiceOptions, votes) {
  const total = COMMITTEE_COUNTRIES.length;
  const rows = choiceOptions.map((choice) => ({
    label: VOTE_CHOICE_LABELS[choice],
    // Reuses the same green/red/gray classes as the vote buttons
    // themselves, so a bar's color always matches its choice.
    className: VOTE_CHOICE_BUTTON_CLASSES[choice],
    countries: COMMITTEE_COUNTRIES.filter((country) => votes[country] === choice),
  }));
  rows.push({
    label: "Not Yet Voted",
    className: "vote-pending",
    countries: COMMITTEE_COUNTRIES.filter((country) => !votes[country]),
  });

  voteStatusChartEl.replaceChildren(
    ...rows.map(({ label, className, countries }) => {
      const row = document.createElement("div");
      const header = document.createElement("div");
      const labelEl = document.createElement("span");
      const countEl = document.createElement("span");
      const track = document.createElement("div");
      const fill = document.createElement("div");
      const names = document.createElement("p");

      row.className = "roll-call-row";
      header.className = "roll-call-row-header";
      track.className = "roll-call-track";
      fill.className = `roll-call-fill ${className}`;
      names.className = "roll-call-names";

      labelEl.textContent = label;
      countEl.textContent = `${countries.length} of ${total}`;
      fill.style.width = `${(countries.length / total) * 100}%`;
      names.textContent = countries.length > 0 ? countries.join(", ") : "None";

      header.append(labelEl, countEl);
      track.append(fill);
      row.append(header, track, names);
      return row;
    }),
  );
}

// Renders the Presence Check (roll call) outcome as a two-bar chart --
// Voting vs Not Voting -- naming which delegates landed in each group.
// Stays visible for the rest of the session as a historical record, and
// is hidden entirely until that first vote has actually passed.
function renderRollCallChart(rollCallVotes) {
  if (!rollCallVotes) {
    rollCallCard.hidden = true;
    return;
  }

  rollCallCard.hidden = false;

  const total = COMMITTEE_COUNTRIES.length;
  const rows = [
    {
      label: "Voting",
      className: "voting",
      countries: COMMITTEE_COUNTRIES.filter((country) => rollCallVotes[country] === "yes"),
    },
    {
      label: "Not Voting",
      className: "not-voting",
      countries: COMMITTEE_COUNTRIES.filter((country) => rollCallVotes[country] !== "yes"),
    },
  ];

  rollCallChart.replaceChildren(
    ...rows.map(({ label, className, countries }) => {
      const row = document.createElement("div");
      const header = document.createElement("div");
      const labelEl = document.createElement("span");
      const countEl = document.createElement("span");
      const track = document.createElement("div");
      const fill = document.createElement("div");
      const names = document.createElement("p");

      row.className = "roll-call-row";
      header.className = "roll-call-row-header";
      track.className = "roll-call-track";
      fill.className = `roll-call-fill ${className}`;
      names.className = "roll-call-names";

      labelEl.textContent = label;
      countEl.textContent = `${countries.length} of ${total}`;
      fill.style.width = `${(countries.length / total) * 100}%`;
      names.textContent = countries.length > 0 ? countries.join(", ") : "None";

      header.append(labelEl, countEl);
      track.append(fill);
      row.append(header, track, names);
      return row;
    }),
  );
}

resetVoteButton.addEventListener("click", () => {
  resetCurrentVote().catch((error) => console.error("Unable to reset the vote:", error));
});

// The Proceed / "I'm Ready" button's action -- see updateProceedUI
// above and markReadyToProceed in committee-data.js. Disabled while
// the write is in flight so a slow connection can't double-send it;
// a successful write hides the button on the next render (see
// updateProceedUI), so there's nothing further to do here on success.
proceedButton.addEventListener("click", () => {
  if (!myAssignedCountry) {
    return;
  }
  proceedButton.disabled = true;
  markReadyToProceed(myAssignedCountry)
    .catch((error) => {
      console.error("Unable to mark ready to proceed:", error);
      proceedStatusEl.hidden = false;
      proceedStatusEl.textContent = "Could not send that -- check your connection and try again.";
    })
    .finally(() => {
      proceedButton.disabled = false;
    });
});

// The "Start Conference" button's action -- irreversible, so this
// confirms first, same as the matching button on chair.html. Unlike
// that one, starting from here always hands the Chair's side of
// things to the AI (see lockRosterAndStart in committee-data.js),
// since nobody reaching this page is signed in as Chair.
delegateStartButton.addEventListener("click", () => {
  const confirmed = window.confirm(
    "Start the conference now? Nobody will be able to join with the meeting code after this, any country nobody has claimed yet becomes an AI Delegate, and the AI will run the Chair's side of things too since you're starting it from here. This can't be undone.",
  );
  if (!confirmed) {
    return;
  }

  delegateStartButton.disabled = true;
  delegateStartStatusEl.textContent = "Starting the conference…";
  lockRosterAndStart({ initiatedByDelegate: true })
    .then((result) => {
      if (!result) {
        // Already locked -- a double-click, or someone else (the
        // owner, from chair.html) got there first. Leave the button
        // disabled; renderCommitteeState will reflect the real state
        // as soon as the snapshot arrives.
        delegateStartStatusEl.textContent = "This conference has already been started.";
        return;
      }
      delegateStartStatusEl.textContent =
        "Started -- the AI is now running the rest of this conference, including the Chair's side of things.";
    })
    .catch((error) => {
      console.error("Unable to start the conference:", error);
      delegateStartStatusEl.textContent = "Could not start the conference -- check your connection and try again.";
      delegateStartButton.disabled = false;
    });
});

// Any delegate can raise either motion during Motion Raising -- see
// castMotion. Disabled entirely for observers (no country to raise one
// as), handled by the disabled state set in renderCommitteeState.
motionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!myAssignedCountry) {
      return;
    }
    castMotion(myAssignedCountry, button.dataset.motion).catch((error) => {
      console.error("Unable to raise the motion:", error);
    });
  });
});

yieldForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!myAssignedCountry) {
    return;
  }
  const message = yieldMessageInput.value.trim();
  if (!message) {
    yieldStatusEl.textContent = "Please type a short message before sending your yield request.";
    return;
  }
  yieldForm.querySelector("button").disabled = true;
  yieldStatusEl.textContent = "Sending yield request…";
  requestYield(myAssignedCountry, message).catch((error) => {
    console.error("Unable to send the yield request:", error);
    yieldStatusEl.textContent = "Could not send the yield request -- check your connection and try again.";
    yieldForm.querySelector("button").disabled = false;
  });
});


// Repairs this session's document if it predates a field this module
// now expects (see ensureCommitteeState in committee-data.js), then
// claims this specific visitor's own country seat. The committee/state
// listener below usually renders first with
// myAssignedCountry still undefined (showing no vote buttons yet) --
// once the claim resolves, this re-renders immediately so the page
// doesn't have to wait for some unrelated change to show it.
ensureCommitteeState()
  .then(() => claimDelegateCountry())
  .then((country) => {
    myAssignedCountry = country;
    applyDelegateIdentityToUI();
    if (latestCommitteeState) {
      renderCommitteeState(latestCommitteeState);
    }
  })
  .catch((error) => {
    console.error("Unable to set up the committee session:", error);
  });

onSnapshot(committeeStateRef, (snapshot) => {
  if (!snapshot.exists()) {
    return;
  }
  setLatestCommitteeState(snapshot.data());

  // If this visitor already has a confirmed country, but the shared
  // state no longer shows them assigned to it, something reset the
  // session (most likely someone clicking Reset Committee Session,
  // which wipes every assignment along with everything else). Carrying
  // on with the old myAssignedCountry would make every later vote or
  // message silently fail Firestore's rules instead of actually
  // working -- so claim a fresh seat right away instead.
  const myUid = auth.currentUser?.uid;
  const stillAssigned =
    typeof myAssignedCountry !== "string" || latestCommitteeState.delegateAssignments?.[myUid] === myAssignedCountry;

  if (!stillAssigned) {
    claimDelegateCountry()
      .then((country) => {
        myAssignedCountry = country;
        applyDelegateIdentityToUI();
        renderCommitteeState(latestCommitteeState);
      })
      .catch((error) => console.error("Unable to re-claim a country after a session reset:", error));
    return;
  }

  renderCommitteeState(latestCommitteeState);
}, (error) => {
  console.error("Unable to load the committee session state:", error);
});

// Saves the shared draft resolution as the delegate types (debounced --
// see scheduleResolutionSave). Disabled textareas don't fire input
// events in the browser, but the check is kept here too in case the
// phase changes out from under an in-progress keystroke.
resolutionTextarea.addEventListener("input", () => {
  if (resolutionTextarea.disabled) {
    return;
  }
  scheduleResolutionSave();
});

// Keeps the shared draft resolution in sync live across everyone's
// device. Skips overwriting the textarea while this delegate is
// actively typing in it, so their own keystrokes are never clobbered
// mid-edit by someone else's save landing at the same moment.
onSnapshot(committeeResolutionRef, (snapshot) => {
  latestResolutionText = snapshot.data()?.text ?? "";
  if (document.activeElement !== resolutionTextarea) {
    resolutionTextarea.value = latestResolutionText;
  }
}, (error) => {
  console.error("Unable to load the draft resolution:", error);
});

// Builds the Play/Pause and Stop buttons for one AI Delegate speech's
// audio, wired to a real <audio> element so a visitor can pause and
// resume a speech instead of only ever hearing it straight through once.
function createAudioControls(audioUrl, country) {
  const audio = new Audio(audioUrl);
  const controls = document.createElement("div");
  const playPauseButton = document.createElement("button");
  const stopButton = document.createElement("button");

  controls.className = "audio-controls";
  playPauseButton.type = "button";
  playPauseButton.className = "audio-control-button";
  playPauseButton.textContent = "▶ Play";
  stopButton.type = "button";
  stopButton.className = "audio-control-button";
  stopButton.textContent = "⏹ Stop";

  playPauseButton.addEventListener("click", () => {
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  });

  stopButton.addEventListener("click", () => {
    audio.pause();
    audio.currentTime = 0;
    playPauseButton.textContent = "▶ Play";
  });

  // Keeps the button label in sync no matter how playback was started,
  // paused, or finished (including the audio simply reaching its end).
  // Every actual play -- including a resume after pausing -- counts as
  // the speech being presented, so it's logged here.
  audio.addEventListener("play", () => {
    playPauseButton.textContent = "⏸ Pause";
    logActivity("speech_played", country, `${country}'s AI speech audio was played.`);
  });
  audio.addEventListener("pause", () => {
    playPauseButton.textContent = "▶ Play";
  });
  audio.addEventListener("ended", () => {
    playPauseButton.textContent = "▶ Play";
  });

  controls.append(playPauseButton, stopButton);
  return controls;
}

// Builds a safe message card without inserting visitor text as HTML. When
// an audioUrl is provided (always an AI Delegate speech, never a human
// message), the card also gets Play/Pause and Stop controls for it.
function createMessageCard({ country, delegateType, message, audioUrl }) {
  const messageCard = document.createElement("article");
  const countryName = document.createElement("span");
  const type = document.createElement("span");
  const messageText = document.createElement("p");

  messageCard.className = "message";
  countryName.className = "message-country";
  type.className = "message-type";
  messageText.className = "message-text";
  countryName.textContent = formatDelegateLabel(country, latestCommitteeState?.delegateNames);
  type.textContent = delegateType;
  messageText.textContent = `“${message}”`;

  messageCard.append(countryName, type, messageText);

  if (audioUrl) {
    messageCard.append(createAudioControls(audioUrl, country));
  }

  return messageCard;
}

// Asks the local server (see app.py) to turn one delegate's speech text
// into spoken audio through the ElevenLabs API, using whichever gender and
// accent choice the visitor picked, then adds the speech -- with playback
// controls -- to the discussion feed. Can be run again for any AI
// Delegate, any number of times.
async function generateAiSpeech() {
  const country = speechCountrySelect.value;
  const gender = speechGenderSelect.value;
  const useAccent = speechAccentCheckbox.checked;
  // Uses whichever topic is currently proposed or adopted for this
  // session, so the speech always matches the committee's actual topic.
  const activeTopic = getTopic(latestCommitteeState?.topicId);
  const delegate = activeTopic?.delegates.find((item) => item.country === country);

  if (!delegate) {
    return;
  }

  speechButton.disabled = true;
  speechStatus.textContent = `Generating ${country}'s speech…`;
  logActivity(
    "speech_requested",
    country,
    `${country}'s AI speech was requested (voice: ${gender}, accent: ${useAccent ? "on" : "off"}).`,
  );

  try {
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: delegate.speech,
        country: delegate.country,
        gender,
        accent: useAccent,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || "The speech could not be generated.");
    }

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);

    discussionFeed.appendChild(
      createMessageCard({
        country: delegate.country,
        delegateType: "AI Delegate",
        message: delegate.speech,
        audioUrl,
      }),
    );
    speechStatus.textContent = `${country}'s AI speech is ready below.`;
    logActivity("speech_ready", country, `${country}'s AI speech audio was generated and displayed in the discussion feed.`);
  } catch (error) {
    console.error("Unable to generate AI speech:", error);
    speechStatus.textContent = error.message || "The speech could not be generated. Please try again.";
  } finally {
    speechButton.disabled = false;
  }
}

speechButton.addEventListener("click", generateAiSpeech);

// Shows the latest submitted human messages to every visitor in real time.
const messagesQuery = query(getCommitteeMessagesCollection(), orderBy("createdAt", "asc"), limit(100));
onSnapshot(messagesQuery, (snapshot) => {
  userMessageFeed.replaceChildren(
    ...snapshot.docs.map((document) => createMessageCard(document.data())),
  );
}, (error) => {
  console.error("Unable to load committee messages:", error);
  messageStatus.textContent = "The discussion could not be loaded. Please refresh and try again.";
});

// Saves a delegate's typed idea to Firestore after Firebase gives them an anonymous ID.
messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  // Observers (and visitors whose assignment hasn't resolved yet) have
  // no country to send a message as -- the form's inputs are already
  // disabled for them (see applyDelegateIdentityToUI), but this guards
  // against a submit that somehow still gets through.
  if (!myAssignedCountry) {
    messageStatus.textContent = "Observers can't send discussion messages.";
    return;
  }
  const country = myAssignedCountry;

  const formData = new FormData(messageForm);
  const message = formData.get("message").trim();

  if (!message) {
    messageStatus.textContent = "Please write a message before sending.";
    return;
  }

  const submitButton = messageForm.querySelector("button");
  submitButton.disabled = true;
  messageStatus.textContent = "Sending your message…";

  try {
    const user = await ensureAnonymousUser();
    await addDoc(getCommitteeMessagesCollection(), {
      authorId: user.uid,
      country,
      delegateType: "Human Delegate",
      message,
      createdAt: serverTimestamp(),
    });
    messageForm.reset();
    messageStatus.textContent = "Your message was added to the discussion.";
    logActivity("message_sent", country, `${country} (Human Delegate) sent a discussion message.`);
  } catch (error) {
    console.error("Unable to save committee message:", error);
    messageStatus.textContent = "Your message could not be sent. Please try again.";
  } finally {
    submitButton.disabled = false;
  }
});
