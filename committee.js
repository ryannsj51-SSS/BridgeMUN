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
  TOPIC_PHASE_INDEX,
  PRESENCE_CHECK_PHASE_INDEX,
  YIELD_TIME_PHASE_INDEX,
  findNextHumanSpeakerIndex,
  TOPIC_VOTE_DURATION_MS,
  VOTE_THRESHOLD,
  VOTE_CHOICE_LABELS,
  VOTE_CHOICE_BUTTON_CLASSES,
  isSigningPhase,
  isTopicPhase,
  voteOutcome,
  committeeStateRef,
  latestCommitteeState,
  setLatestCommitteeState,
  committeeResolutionRef,
  RESOLUTION_MAX_LENGTH,
  RESOLUTION_EDITABLE_START_INDEX,
  RESOLUTION_EDITABLE_END_INDEX,
  isResolutionEditablePhase,
  initialVotesForPhase,
  logActivity,
  ensureCommitteeState,
  joinSessionByCode,
  getCommitteeMessagesCollection,
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
      // ensureCommitteeState() always runs first and creates this
      // document -- this is just a safety net in case that ever races.
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
const topicVoteTimerEl = document.getElementById("topic-vote-timer");
const voteQuestionEl = document.getElementById("vote-question");
const voteStatusChartEl = document.getElementById("vote-status-chart");
const voteRowsEl = document.getElementById("vote-rows");
const voteStatusEl = document.getElementById("vote-status");
const resetVoteButton = document.getElementById("reset-vote-button");

// Elements for the Yield Time speaking-order panel.
const yieldCard = document.getElementById("yield-card");
const yieldOrderListEl = document.getElementById("yield-order-list");
const yieldButton = document.getElementById("yield-button");
const yieldStatusEl = document.getElementById("yield-status");

// Elements for the shared Draft Resolution document.
const resolutionCard = document.getElementById("resolution-card");
const resolutionHintEl = document.getElementById("resolution-hint");
const resolutionTextarea = document.getElementById("resolution-textarea");
const resolutionStatusEl = document.getElementById("resolution-status");

// The committee topic banner at the top of the page -- shows whichever
// topic is currently proposed or, once Setting the Agenda has passed,
// the topic that was actually adopted for the rest of the session.
const committeeTopicLabelEl = document.getElementById("committee-topic-label");
const committeeTopicTextEl = document.getElementById("committee-topic-text");

// Elements for the Roll Call Results bar chart (the Presence Check outcome).
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
// immediately auto-vote Yes again) so delegates can retry a failed motion.
async function resetCurrentVote() {
  await ensureAnonymousUser();
  const phaseName = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    // Setting the Agenda never uses this manual reset -- a failed or
    // timed-out topic vote proposes a new topic automatically instead.
    if (data.phaseIndex === TOPIC_PHASE_INDEX) {
      return null;
    }
    transaction.update(committeeStateRef, {
      votes: initialVotesForPhase(data.delegateRoles, data.phaseIndex),
      updatedAt: serverTimestamp(),
    });
    return COMMITTEE_PHASES[data.phaseIndex];
  });

  if (phaseName) {
    logActivity("vote_reset", null, `The vote for ${phaseName} was reset after the motion failed.`);
  }
}

// Records one Human Delegate's Yes/No vote. If that vote gives the
// passing choice a majority of all delegates, this same write advances
// the committee to the next phase and starts a fresh vote for it --
// done inside one transaction so it stays correct even if multiple
// visitors vote at the same moment.
async function castVote(country, choice) {
  await ensureAnonymousUser();

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    // Setting the Agenda has its own vote function (castTopicVote) with
    // its own choices (agree/disagree) and anonymity handling -- refuse
    // to run here so a stale button from a previous render (e.g. right
    // before someone else reset the session or the topic was
    // re-proposed) can never write an invalid "yes"/"no" vote into that
    // phase's data.
    if (data.phaseIndex === TOPIC_PHASE_INDEX) {
      return null;
    }
    const votes = { ...data.votes, [country]: choice };
    const phaseName = COMMITTEE_PHASES[data.phaseIndex];
    const isLastPhase = data.phaseIndex >= COMMITTEE_PHASES.length - 1;
    const passingValue = isSigningPhase(data.phaseIndex) ? "sign" : "yes";

    if (voteOutcome(votes, passingValue) === "passed" && !isLastPhase) {
      const update = {
        phaseIndex: data.phaseIndex + 1,
        votes: initialVotesForPhase(data.delegateRoles, data.phaseIndex + 1),
        updatedAt: serverTimestamp(),
      };

      // Entering Yield Time starts the speaking order over at the
      // first human delegate (AI Delegates are skipped automatically --
      // see findNextHumanSpeakerIndex), so whoever gets the floor next
      // is always a real person who can actually click Yield.
      if (data.phaseIndex + 1 === YIELD_TIME_PHASE_INDEX) {
        update.currentSpeakerIndex = findNextHumanSpeakerIndex(data.delegateRoles, 0);
      }

      // The Presence Check result becomes the permanent Roll Call Results
      // record -- any delegate who never got to vote Yes counts as Not
      // Voting, since the roll call has now closed.
      let rollCallSummary = null;
      if (data.phaseIndex === PRESENCE_CHECK_PHASE_INDEX) {
        const rollCallVotes = {};
        COMMITTEE_COUNTRIES.forEach((country2) => {
          rollCallVotes[country2] = votes[country2] === "yes" ? "yes" : "no";
        });
        update.rollCallVotes = rollCallVotes;

        const votingCountries = COMMITTEE_COUNTRIES.filter((c) => rollCallVotes[c] === "yes");
        const notVotingCountries = COMMITTEE_COUNTRIES.filter((c) => rollCallVotes[c] === "no");
        rollCallSummary =
          `Voting: ${votingCountries.join(", ") || "None"}. ` +
          `Not Voting: ${notVotingCountries.join(", ") || "None"}.`;
      }

      transaction.update(committeeStateRef, update);
      return { phaseName, advancedTo: COMMITTEE_PHASES[data.phaseIndex + 1], rollCallSummary };
    }

    transaction.update(committeeStateRef, {
      votes,
      updatedAt: serverTimestamp(),
    });

    // Signing is the last phase, so it never hits the "advance" branch
    // above -- passing here means the whole committee session is done.
    const sessionComplete = isLastPhase && voteOutcome(votes, passingValue) === "passed";
    return { phaseName, advancedTo: null, rollCallSummary: null, sessionComplete };
  });

  if (!result) {
    return;
  }

  logActivity(
    "vote_cast",
    country,
    `${country} voted ${VOTE_CHOICE_LABELS[choice] ?? choice} during ${result.phaseName}.`,
  );

  if (result.advancedTo) {
    logActivity(
      "phase_advanced",
      null,
      `Committee advanced from ${result.phaseName} to ${result.advancedTo} by majority vote.`,
    );
  }

  if (result.sessionComplete) {
    logActivity("session_complete", null, "The resolution passed Signing by majority vote. Committee session complete.");
  }

  if (result.rollCallSummary) {
    logActivity(
      "roll_call_completed",
      null,
      `Roll call finished and the Roll Call Results chart was generated. ${result.rollCallSummary}`,
    );
  }
}

// Lets whichever delegate currently has the floor during Yield Time
// yield their remaining speaking time to the Chair, handing the floor
// to the next human delegate in order (AI Delegates are skipped
// automatically). This is purely a live, visible record of who's
// spoken -- it doesn't cast a Yes/No vote or advance the phase by
// itself; the normal majority vote above still does that separately.
async function castYield(country) {
  await ensureAnonymousUser();

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return;
    }

    const data = snapshot.data();
    // Guards against a stale button (left over from a previous render,
    // e.g. right before the session was reset or the floor already
    // moved on) ever yielding for the wrong phase or the wrong country.
    if (data.phaseIndex !== YIELD_TIME_PHASE_INDEX) {
      return;
    }
    const currentSpeakerIndex = data.currentSpeakerIndex ?? 0;
    if (COMMITTEE_COUNTRIES[currentSpeakerIndex] !== country) {
      return;
    }

    transaction.update(committeeStateRef, {
      currentSpeakerIndex: findNextHumanSpeakerIndex(data.delegateRoles, currentSpeakerIndex + 1),
      updatedAt: serverTimestamp(),
    });
  });

  logActivity("yield_cast", country, `${country} yielded their remaining speaking time to the Chair.`);
}

// Records one Human Delegate's Agree/Disagree vote on the proposed topic,
// with an optional anonymous flag that hides which country cast it from
// everyone else watching live (the vote still counts the same either
// way). If the vote reaches a majority Agree, the committee advances to
// Presence Check with this topic locked in for the rest of the session.
// If a majority is no longer mathematically possible, the chair
// immediately proposes a different topic and starts a fresh vote --
// the same thing that happens automatically when the 60-second time
// limit runs out (see expireTopicVoteIfNeeded below).
async function castTopicVote(country, choice, anonymous) {
  await ensureAnonymousUser();

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    if (data.phaseIndex !== TOPIC_PHASE_INDEX) {
      return null;
    }

    const votes = { ...data.votes, [country]: choice };
    const topicVoteAnonymous = { ...data.topicVoteAnonymous, [country]: anonymous };
    const outcome = voteOutcome(votes, "agree");
    const currentTopic = getTopic(data.topicId);

    if (outcome === "passed") {
      transaction.update(committeeStateRef, {
        phaseIndex: PRESENCE_CHECK_PHASE_INDEX,
        votes: initialVotesForPhase(data.delegateRoles, PRESENCE_CHECK_PHASE_INDEX),
        topicVoteAnonymous,
        updatedAt: serverTimestamp(),
      });
      return { action: "adopted", topicName: currentTopic?.name, choice };
    }

    if (outcome === "failed") {
      const nextTopicId = randomTopicId(data.topicId);
      transaction.update(committeeStateRef, {
        topicId: nextTopicId,
        votes: initialVotesForPhase(data.delegateRoles, TOPIC_PHASE_INDEX),
        topicVoteAnonymous: {},
        topicVoteDeadlineMs: Date.now() + TOPIC_VOTE_DURATION_MS,
        updatedAt: serverTimestamp(),
      });
      return { action: "reproposed", fromTopicName: currentTopic?.name, toTopicName: getTopic(nextTopicId)?.name, choice };
    }

    transaction.update(committeeStateRef, {
      votes,
      topicVoteAnonymous,
      updatedAt: serverTimestamp(),
    });
    return { action: "recorded", topicName: currentTopic?.name, choice };
  });

  if (!result) {
    return;
  }

  logActivity(
    "topic_vote_cast",
    country,
    `${country} voted ${VOTE_CHOICE_LABELS[result.choice] ?? result.choice} on the proposed topic (${result.topicName ?? "unknown"}).`,
  );

  if (result.action === "adopted") {
    logActivity(
      "topic_adopted",
      null,
      `The committee adopted "${result.topicName}" as its topic by majority vote and moved to Presence Check.`,
    );
  }

  if (result.action === "reproposed") {
    logActivity(
      "topic_reproposed",
      null,
      `"${result.fromTopicName}" did not reach a majority, so the chair proposed a new topic: "${result.toTopicName}".`,
    );
  }
}

// Runs automatically while Setting the Agenda's countdown ticks (and once
// on page load, in case everyone was away when time actually ran out). If
// the 60-second window has passed and the vote still hasn't reached a
// majority, the chair proposes a different topic and starts the clock
// over -- no manual reset needed for this phase, unlike every other one.
async function expireTopicVoteIfNeeded() {
  await ensureAnonymousUser();

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(committeeStateRef);
    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.data();
    if (data.phaseIndex !== TOPIC_PHASE_INDEX) {
      return null;
    }
    if (Date.now() < data.topicVoteDeadlineMs) {
      return null;
    }
    if (voteOutcome(data.votes, "agree") === "passed") {
      return null;
    }

    const currentTopic = getTopic(data.topicId);
    const nextTopicId = randomTopicId(data.topicId);
    transaction.update(committeeStateRef, {
      topicId: nextTopicId,
      votes: initialVotesForPhase(data.delegateRoles, TOPIC_PHASE_INDEX),
      topicVoteAnonymous: {},
      topicVoteDeadlineMs: Date.now() + TOPIC_VOTE_DURATION_MS,
      updatedAt: serverTimestamp(),
    });
    return { fromTopicName: currentTopic?.name, toTopicName: getTopic(nextTopicId)?.name };
  });

  if (result) {
    logActivity(
      "topic_reproposed",
      null,
      `The 60-second vote on "${result.fromTopicName}" timed out, so the chair proposed a new topic: "${result.toTopicName}".`,
    );
  }
}

// Updates the visible Setting the Agenda countdown from whatever the
// latest shared state says, and triggers the automatic re-proposal above
// once the 60-second window closes. Runs both right after any Firestore
// update and every second on a timer, so the countdown keeps ticking down
// live even when nobody else is voting.
function updateTopicVoteTimerDisplay() {
  if (!latestCommitteeState || !isTopicPhase(latestCommitteeState.phaseIndex)) {
    topicVoteTimerEl.hidden = true;
    return;
  }

  topicVoteTimerEl.hidden = false;
  const remainingMs = latestCommitteeState.topicVoteDeadlineMs - Date.now();

  if (remainingMs <= 0) {
    topicVoteTimerEl.textContent = "Time's up -- proposing a new topic\u2026";
    expireTopicVoteIfNeeded().catch((error) => console.error("Unable to expire the topic vote:", error));
    return;
  }

  topicVoteTimerEl.textContent = `Time remaining to vote: ${Math.ceil(remainingMs / 1000)}s`;
}

setInterval(updateTopicVoteTimerDisplay, 1000);

// Renders the delegate list, the AI-speech dropdown, and the whole voting
// panel from one shared committee-state snapshot. Runs for every visitor
// whenever anyone's vote or the phase changes.
// Saves the shared draft resolution a short moment after the delegate
// stops typing -- debounced so we're not writing to Firestore on every
// single keystroke. Each new keystroke restarts the delay.
function scheduleResolutionSave() {
  resolutionStatusEl.textContent = "Saving\u2026";
  if (resolutionSaveTimeoutId) {
    clearTimeout(resolutionSaveTimeoutId);
  }
  resolutionSaveTimeoutId = setTimeout(async () => {
    // The phase can change while this delay is still counting down (for
    // example, the chair advances to Signing right after someone's last
    // keystroke in Drafting Solutions) -- re-check here, right before
    // writing, instead of relying only on the disabled textarea, so a
    // save that's no longer allowed doesn't reach Firestore and come
    // back looking like a connection problem.
    if (!isResolutionEditablePhase(latestCommitteeState?.phaseIndex) || !myAssignedCountry) {
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
// phase: hidden before Moderated Caucus, editable through Moderated
// Caucus / Unmoderated Caucus / Drafting Solutions, then visible but
// read-only from Signing onward so delegates can review exactly what
// they're voting to sign.
function renderResolutionCard(phaseIndex) {
  const editable = isResolutionEditablePhase(phaseIndex) && Boolean(myAssignedCountry);
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
  } else if (isResolutionEditablePhase(phaseIndex)) {
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
// their turn.
function renderYieldCard(phaseIndex, delegateRoles, currentSpeakerIndex) {
  const onYieldPhase = phaseIndex === YIELD_TIME_PHASE_INDEX;
  yieldCard.hidden = !onYieldPhase;
  if (!onYieldPhase) {
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
      name.textContent = country;
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
  yieldButton.hidden = !isMyTurn;
  yieldButton.disabled = false;

  if (allDone) {
    yieldStatusEl.textContent = "Every delegate has had the floor -- vote above to proceed to Moderated Caucus.";
  } else if (isMyTurn) {
    yieldStatusEl.textContent = "You have the floor -- yield your remaining time to the Chair when you're ready.";
  } else if (myStatus === "waiting") {
    yieldStatusEl.textContent =
      myQueuePosition === 1
        ? `You're next, right after ${currentSpeaker} yields.`
        : `You're ${ordinal(myQueuePosition)} in the queue, after ${currentSpeaker}.`;
  } else if (myStatus === "done") {
    yieldStatusEl.textContent = "You've already yielded your time to the Chair.";
  } else if (currentSpeaker) {
    yieldStatusEl.textContent = `Waiting for ${currentSpeaker} to yield.`;
  } else {
    yieldStatusEl.textContent = "";
  }
}

function renderCommitteeState(data) {
  const { phaseIndex, delegateRoles, votes, rollCallVotes, topicId, topicVoteAnonymous, currentSpeakerIndex } = data;
  const phaseName = COMMITTEE_PHASES[phaseIndex];
  const isLastPhase = isSigningPhase(phaseIndex);
  const onTopicPhase = isTopicPhase(phaseIndex);
  const passingValue = isLastPhase ? "sign" : onTopicPhase ? "agree" : "yes";
  const outcome = voteOutcome(votes, passingValue);
  const sessionComplete = isLastPhase && outcome === "passed";
  const currentTopic = getTopic(topicId);

  if (lastAnnouncedPhaseIndex !== null && phaseIndex !== lastAnnouncedPhaseIndex) {
    showPhaseToast(`Now entering: ${phaseName}`);
  }
  lastAnnouncedPhaseIndex = phaseIndex;

  renderTimelineTable(phaseIndex, sessionComplete);
  renderRollCallChart(rollCallVotes);
  renderYieldCard(phaseIndex, delegateRoles, currentSpeakerIndex ?? 0);
  renderResolutionCard(phaseIndex);
  applyDelegateIdentityToUI();

  // The committee topic banner at the top of the page: shows what's
  // currently proposed while Setting the Agenda is underway, and what was
  // adopted for the rest of the session once that vote passes.
  if (currentTopic) {
    committeeTopicLabelEl.textContent = onTopicPhase ? "Proposed Topic" : "Topic";
    committeeTopicTextEl.textContent = `${currentTopic.name} \u2014 ${currentTopic.description}`;
  }

  // The 60-second countdown only applies to Setting the Agenda -- every
  // other phase has no time limit and can be reset manually instead.
  updateTopicVoteTimerDisplay();

  phaseStepEl.textContent = `Phase ${phaseIndex + 1} of ${COMMITTEE_PHASES.length}`;
  phaseNameEl.textContent = phaseName;

  // Delegate list, with each country's role for this committee session.
  delegateList.replaceChildren(
    ...COMMITTEE_COUNTRIES.map((country) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      const role = document.createElement("span");

      item.className = "delegate";
      role.className = "role";
      name.textContent = country;
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

  // The session is fully finished once Signing (the last phase) has also
  // passed by majority -- nothing left to vote on but a fresh restart.
  if (sessionComplete) {
    voteQuestionEl.textContent = "This committee session is complete.";
    voteStatusChartEl.replaceChildren();
    voteRowsEl.replaceChildren();
    voteStatusEl.textContent = "Every phase from Setting the Agenda through Signing has passed by majority vote.";
    resetVoteButton.hidden = true;
    return;
  }

  const nextPhaseName = COMMITTEE_PHASES[phaseIndex + 1];
  if (onTopicPhase) {
    voteQuestionEl.textContent = currentTopic
      ? `Vote on whether to adopt "${currentTopic.name}" and begin debate:`
      : "Vote on whether to adopt the proposed topic and begin debate:";
  } else if (isSigningPhase(phaseIndex)) {
    voteQuestionEl.textContent = "Vote on whether to sign this resolution into adoption:";
  } else if (phaseIndex === PRESENCE_CHECK_PHASE_INDEX) {
    voteQuestionEl.textContent = "Vote to confirm presence and proceed to the General Speakers List:";
  } else {
    voteQuestionEl.textContent = `Vote to proceed from ${phaseName} to ${nextPhaseName}:`;
  }

  // Setting the Agenda votes Agree/Disagree, Signing votes Sign/Not Sign/
  // Abstain, and every other phase votes Yes/No.
  const choiceOptions = onTopicPhase
    ? ["agree", "disagree"]
    : isSigningPhase(phaseIndex)
      ? ["sign", "not_sign", "abstain"]
      : ["yes", "no"];
  const aiAutoChoice = onTopicPhase ? "agree" : isSigningPhase(phaseIndex) ? "sign" : "yes";

  renderVoteStatusChart(choiceOptions, votes);

  voteRowsEl.replaceChildren(
    ...COMMITTEE_COUNTRIES.map((country) => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      const status = document.createElement("span");

      row.className = "vote-row";
      label.textContent = country;
      status.className = "vote-choice";

      if (delegateRoles[country] === "ai") {
        // During the Presence Check, an automatic Yes reads as "Present",
        // matching real roll-call language -- every other phase shows the
        // AI Delegate's automatic choice for that phase (Agree on Setting
        // the Agenda, Sign on Signing).
        status.textContent =
          phaseIndex === PRESENCE_CHECK_PHASE_INDEX
            ? "Present (AI, automatic)"
            : `${VOTE_CHOICE_LABELS[aiAutoChoice]} (AI, automatic)`;
        row.append(label, status);
        return row;
      }

      const currentVote = votes[country];
      if (currentVote) {
        // A vote cast anonymously during Setting the Agenda hides which
        // country it came from -- everyone else just sees "Anonymous
        // Delegate" instead of the real country name.
        const votedAnonymously = onTopicPhase && Boolean(topicVoteAnonymous?.[country]);
        label.textContent = votedAnonymously ? "Anonymous Delegate" : country;
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
        if (onTopicPhase) {
          button.addEventListener("click", () => {
            const anonymousCheckbox = row.querySelector(".anonymous-checkbox");
            // A visible pop-up naming the topic right as the vote is cast
            // -- the topic banner at the top of the page can be easy to
            // miss, so this makes sure whoever's voting knows exactly
            // what they're voting on.
            if (currentTopic) {
              showPhaseToast(`Voting on: ${currentTopic.name} \u2014 ${currentTopic.description}`);
            }
            castTopicVote(country, choice, Boolean(anonymousCheckbox?.checked));
          });
        } else {
          button.addEventListener("click", () => castVote(country, choice));
        }
        buttonGroup.append(button);
      });

      if (onTopicPhase) {
        // Lets a delegate hide which country their vote came from --
        // asked for up front, before the vote is cast.
        const controls = document.createElement("div");
        const anonymousLabel = document.createElement("label");
        const anonymousCheckbox = document.createElement("input");

        controls.className = "vote-topic-controls";
        anonymousLabel.className = "anonymous-toggle";
        anonymousCheckbox.type = "checkbox";
        anonymousCheckbox.className = "anonymous-checkbox";
        anonymousLabel.append(anonymousCheckbox, document.createTextNode(" Vote anonymously"));

        controls.append(anonymousLabel, buttonGroup);
        row.append(label, controls);
        return row;
      }

      row.append(label, buttonGroup);
      return row;
    }),
  );

  const passCount = COMMITTEE_COUNTRIES.filter((country) => votes[country] === passingValue).length;

  // Setting the Agenda never shows a manual Reset Vote button -- a failed
  // or timed-out vote proposes a new topic automatically instead.
  if (onTopicPhase) {
    voteStatusEl.textContent =
      outcome === "failed"
        ? "This topic is no longer able to reach a majority -- the chair will propose a new topic automatically."
        : `${passCount} of ${COMMITTEE_COUNTRIES.length} delegates have voted Agree. A majority (at least ${VOTE_THRESHOLD}) is needed to adopt this topic.`;
    resetVoteButton.hidden = true;
    return;
  }

  if (outcome === "failed") {
    const failMessage = isSigningPhase(phaseIndex)
      ? `This resolution did not pass -- a majority (at least ${VOTE_THRESHOLD} of ${COMMITTEE_COUNTRIES.length}) voting Sign is required, and that's no longer possible with the votes already cast. Reset the vote to try again.`
      : `This motion did not pass -- a majority (at least ${VOTE_THRESHOLD} of ${COMMITTEE_COUNTRIES.length}) is required, and that's no longer possible with the votes already cast. Reset the vote to try again.`;
    voteStatusEl.textContent = failMessage;
    resetVoteButton.hidden = false;
  } else {
    const pendingMessage = isSigningPhase(phaseIndex)
      ? `${passCount} of ${COMMITTEE_COUNTRIES.length} delegates have voted Sign. A majority (at least ${VOTE_THRESHOLD}) is needed to adopt the resolution.`
      : `${passCount} of ${COMMITTEE_COUNTRIES.length} delegates have voted Yes. A majority (at least ${VOTE_THRESHOLD}) is needed to proceed.`;
    voteStatusEl.textContent = pendingMessage;
    resetVoteButton.hidden = true;
  }
}

// Renders a live bar chart of how the CURRENT vote is going: one bar per
// choice available in this phase (Agree/Disagree, Yes/No, or Sign/Not
// Sign/Abstain), plus a "Not Yet Voted" bar for anyone still pending.
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

yieldButton.addEventListener("click", () => {
  if (!myAssignedCountry) {
    return;
  }
  yieldButton.disabled = true;
  yieldStatusEl.textContent = "Yielding…";
  castYield(myAssignedCountry).catch((error) => {
    console.error("Unable to yield:", error);
    yieldStatusEl.textContent = "Could not yield -- check your connection and try again.";
    yieldButton.disabled = false;
  });
});


// Sets up the shared committee session (creating it if this is the
// first visitor ever), then claims this specific visitor's own country
// seat. The committee/state listener below usually renders first with
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
  countryName.textContent = country;
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
