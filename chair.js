// The chair dashboard: gated to whichever signed-in Google account owns
// THIS specific conference (the ?code= in the URL -- see
// createOwnedConference in committee-data.js, where every conference
// records its owner's uid at creation). Shows the same live committee
// state the delegate page does, but read-only where
// the delegate page votes or messages -- plus several chair-only
// controls: picking the Conference Setup topic directly, moving the
// committee on from whichever phase the Chair (rather than a delegate
// vote) is the one driving, opening a vote once a motion is raised or
// the resolution is ready, and approving a delegate's yield request.
import { auth, db, doc, getDoc, isGoogleUser, onAuthStateChanged, onSnapshot, runTransaction, serverTimestamp, signOut } from "./firebase.js";
import {
  COMMITTEE_PHASE_DESCRIPTIONS,
  COMMITTEE_TOPICS,
  COMMITTEE_COUNTRIES,
  getTopic,
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
  startConferenceAndAnnounce,
  findNextHumanSpeakerIndex,
  VOTE_THRESHOLD,
  VOTE_CHOICE_LABELS,
  isFinalSigningVote,
  voteOutcome,
  committeeStateRef,
  latestCommitteeState,
  setLatestCommitteeState,
  initialVotesForPhase,
  logActivity,
  ensureCommitteeState,
  createOwnedConference,
  setActiveSessionCode,
  formatDelegateLabel,
  lockRosterAndStart,
  advanceOpeningSpeechesPhase,
  openRaisedMotionVote,
  beginResolutionDrafting,
  openFinalResolutionVote,
  syncAiAutoAdvance,
  openReadinessCheck,
} from "./committee-data.js";

const checkingCard = document.getElementById("chair-checking-card");
const dashboard = document.getElementById("chair-dashboard");
const chairEmailEl = document.getElementById("chair-email");
const sessionCodeEl = document.getElementById("chair-session-code");
const signOutButton = document.getElementById("sign-out-button");

const phaseStepEl = document.getElementById("chair-phase-step");
const phaseNameEl = document.getElementById("chair-phase-name");
const topicTextEl = document.getElementById("chair-topic-text");
const topicChoiceListEl = document.getElementById("topic-choice-list");
const topicChoiceNoteEl = document.getElementById("topic-choice-note");
const topicChoiceStatusEl = document.getElementById("topic-choice-status");

const chairVoteSectionEl = document.getElementById("chair-vote-section");
const voteSummaryEl = document.getElementById("chair-vote-summary");
const voteRowsEl = document.getElementById("chair-vote-rows");

const chairYieldCard = document.getElementById("chair-yield-card");
const chairYieldOrderListEl = document.getElementById("chair-yield-order-list");

const rosterListEl = document.getElementById("roster-list");
const timelineBodyEl = document.getElementById("chair-timeline-body");

const resetSessionButton = document.getElementById("reset-session-button");
const resetSessionStatusEl = document.getElementById("reset-session-status");

// Controls the Chair uses to move the committee along from whichever
// phase a delegate vote doesn't drive on its own -- see renderChairState
// for exactly when each of these is shown.
const startConferenceButton = document.getElementById("start-conference-button");
const startConferencePreviewEl = document.getElementById("start-conference-preview");
const beginMotionsButton = document.getElementById("begin-motions-button");
const chairMotionStatusEl = document.getElementById("chair-motion-status");
const openMotionVoteButton = document.getElementById("open-motion-vote-button");
const chairYieldRequestStatusEl = document.getElementById("chair-yield-request-status");
const approveYieldButton = document.getElementById("approve-yield-button");
const advanceToResolutionButton = document.getElementById("advance-to-resolution-button");
const openFinalVoteButton = document.getElementById("open-final-vote-button");
const chairActionsStatusEl = document.getElementById("chair-actions-status");
const openReadinessCheckButton = document.getElementById("open-readiness-check-button");
const readinessCheckStatusEl = document.getElementById("readiness-check-status");

// The "Start Conference" roster lock, between the title and the rest
// of the dashboard -- see renderChairState for how these three track
// rosterLocked/chairIsAi, and the AI-auto-advance driver near the
// bottom of this file for what runs once chairIsAi is true.
const rosterLockButton = document.getElementById("lock-roster-button");
const rosterLockStatusEl = document.getElementById("roster-lock-status");
const aiChairBadgeEl = document.getElementById("ai-chair-badge");

// Controls for the chair's own copy of the AI-speech feature (same one
// the delegate page offers -- see speechCountrySelect etc. in
// committee.js) -- picking which AI delegate, voice gender, and accent
// setting to use before generating that delegate's speech as audio.
const speechCountrySelect = document.getElementById("chair-speech-country");
const speechGenderSelect = document.getElementById("chair-speech-gender");
const speechAccentCheckbox = document.getElementById("chair-speech-accent");
const speechButton = document.getElementById("chair-ai-speech-button");
const speechStatusEl = document.getElementById("chair-speech-status");
const speechFeedEl = document.getElementById("chair-speech-feed");

// Which conference this dashboard is for -- carried in the URL (see
// my-page.js, which links here as chair.html?code=XXXXXX right after
// creating one) rather than auto-discovered, since any number of
// people can each own their own conference now.
const requestedCode = new URLSearchParams(window.location.search).get("code");

// Only ever lets the conference's actual owner see the dashboard --
// anyone else (not signed in, signed in anonymously, no code in the
// URL, a code that doesn't exist, or a code that belongs to someone
// else) is sent back to the visitor's own personal page instead.
// onAuthStateChanged fires once right away with whatever Firebase
// already knows, so there's no flash of the real dashboard before this
// check runs.
onAuthStateChanged(auth, (user) => {
  if (!isGoogleUser(user) || !requestedCode) {
    window.location.href = isGoogleUser(user) ? "my-page.html" : "join.html";
    return;
  }

  chairEmailEl.textContent = `Signed in as ${user.email}`;

  // Confirms this conference actually exists and that THIS user is the
  // one who created it before showing anything else -- everything
  // below assumes committeeStateRef already points at a session this
  // user is allowed to run.
  const stateRef = doc(db, "sessions", requestedCode, "committee", "state");
  getDoc(stateRef)
    .then((snapshot) => {
      if (!snapshot.exists() || snapshot.data().ownerUid !== user.uid) {
        window.location.href = "my-page.html";
        return;
      }

      setActiveSessionCode(requestedCode);
      sessionCodeEl.textContent = requestedCode;
      startListeningToCommitteeState();
      checkingCard.hidden = true;
      dashboard.hidden = false;
      return ensureCommitteeState();
    })
    .catch((error) => {
      console.error("Unable to set up the committee session:", error);
    });
});

signOutButton.addEventListener("click", () => {
  signOut(auth)
    .then(() => {
      window.location.href = "join.html";
    })
    .catch((error) => console.error("Sign-out failed:", error));
});

resetSessionButton.addEventListener("click", () => {
  const confirmed = window.confirm(
    "Start a brand-new committee session? This issues a new meeting code and clears every vote and delegate assignment from the current one. This can't be undone.",
  );
  if (!confirmed) {
    return;
  }

  resetSessionStatusEl.textContent = "Starting a new session…";
  createOwnedConference(auth.currentUser.uid)
    .then((code) => {
      // The new code belongs in the URL too, so a page refresh (or
      // sharing the link) keeps pointing at the right conference.
      window.history.replaceState(null, "", `chair.html?code=${code}`);
      sessionCodeEl.textContent = code;
      startListeningToCommitteeState();
      resetSessionStatusEl.textContent = `New session started. Meeting code: ${code}.`;
    })
    .catch((error) => {
      console.error("Unable to start a new committee session:", error);
      resetSessionStatusEl.textContent = "Could not start a new session -- check your connection and try again.";
    });
});

// The "Start Conference" button's action -- irreversible, so this
// confirms first, same as Reset Committee Session above. See
// lockRosterAndStart in committee-data.js for exactly what it changes.
rosterLockButton.addEventListener("click", () => {
  const confirmed = window.confirm(
    "Start the conference now? Nobody will be able to join with the meeting code after this -- any country nobody has claimed yet becomes an AI Delegate. This can't be undone.",
  );
  if (!confirmed) {
    return;
  }

  rosterLockButton.disabled = true;
  rosterLockStatusEl.textContent = "Starting the conference…";
  lockRosterAndStart()
    .then((result) => {
      if (!result) {
        // Already locked -- a double-click, or another tab got there
        // first. Leave the button disabled; renderChairState will
        // reflect the real state as soon as the snapshot arrives.
        rosterLockStatusEl.textContent = "This conference has already been started.";
        return;
      }
      rosterLockStatusEl.textContent = result.anyoneJoined
        ? "Registration is now closed. Every unclaimed seat is now an AI Delegate."
        : "Nobody joined, so this conference is now fully AI-run -- choose a topic below to begin.";
    })
    .catch((error) => {
      console.error("Unable to start the conference:", error);
      rosterLockStatusEl.textContent = "Could not start the conference -- check your connection and try again.";
      rosterLockButton.disabled = false;
    });
});

// Sets the Conference Setup topic directly to the chair's choice,
// instead of leaving it as whatever was randomly proposed. Does nothing
// once the committee has moved past Conference Setup (the buttons are
// disabled then anyway, but phase changes can land mid-click).
async function chooseTopic(topicId) {
  topicChoiceStatusEl.textContent = "Setting topic…";
  try {
    const result = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(committeeStateRef);
      if (!snapshot.exists()) {
        return null;
      }

      const data = snapshot.data();
      if (data.phaseIndex !== SETUP_PHASE_INDEX) {
        return null;
      }

      // Changing the topic after the goal-agreement poll has already
      // opened (and, in practice, already failed) reopens that same
      // poll with a clean set of votes -- this is how a failed poll
      // recovers, instead of a separate "Reopen Poll" button.
      const reopeningPoll = data.setupStage === SETUP_STAGE.GOAL_POLL;
      transaction.update(committeeStateRef, {
        topicId,
        // Confirms the Chair has picked a topic -- the one piece of
        // human (or AI-chair) judgment this app still asks for. Only
        // matters once chairIsAi is also true (see syncAiAutoAdvance
        // below), but harmless to set every time a topic is chosen.
        topicConfirmedByChair: true,
        ...(reopeningPoll ? { votes: initialVotesForPhase(data.delegateRoles, SETUP_PHASE_INDEX) } : {}),
        updatedAt: serverTimestamp(),
      });
      return { reopeningPoll };
    });

    if (result) {
      topicChoiceStatusEl.textContent = result.reopeningPoll
        ? `Topic set to "${getTopic(topicId)?.name}" -- the goal-agreement poll has been reopened.`
        : `Topic set to "${getTopic(topicId)?.name}".`;
      logActivity(
        "topic_chosen_by_chair",
        null,
        result.reopeningPoll
          ? `The chair changed the topic to ${getTopic(topicId)?.name} and reopened the goal-agreement poll.`
          : `The chair set the topic to: ${getTopic(topicId)?.name}.`,
      );
    } else {
      topicChoiceStatusEl.textContent = "The committee has already moved past Conference Setup.";
    }
  } catch (error) {
    console.error("Unable to set the topic:", error);
    topicChoiceStatusEl.textContent = "Could not set the topic -- check your connection and try again.";
  }
}

// Bumps the running conference count, sends every delegate the welcome
// message, and opens the goal-agreement poll -- see
// startConferenceAndAnnounce in committee-data.js, which this just
// wraps with status text for the dashboard. Does nothing if the
// presence check hasn't passed yet (the button is hidden then anyway,
// but phase changes can land mid-click).
async function beginConference() {
  startConferencePreviewEl.textContent = "Starting the conference…";
  try {
    const conferenceNumber = await startConferenceAndAnnounce();
    if (conferenceNumber != null) {
      startConferencePreviewEl.textContent = `Delegates now see: "${conferenceWelcomeMessage(conferenceNumber)}"`;
    } else {
      startConferencePreviewEl.textContent = "The conference has already been started, or presence hasn't been confirmed yet.";
    }
  } catch (error) {
    console.error("Unable to start the conference:", error);
    startConferencePreviewEl.textContent = "Could not start the conference -- check your connection and try again.";
  }
}

// Builds the five topic-choice buttons once -- renderChairState just
// updates which one is highlighted and whether they're clickable.
topicChoiceListEl.replaceChildren(
  ...COMMITTEE_TOPICS.map((topic) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "topic-choice-button";
    button.dataset.topicId = topic.id;
    button.textContent = `${topic.name} — ${topic.description}`;
    button.addEventListener("click", () => chooseTopic(topic.id));
    return button;
  }),
);

// Moves the committee on from Opening Speeches to Motion Raising --
// nothing here is delegate-voted, so only the Chair decides when
// speeches are done. Does nothing if the committee has already moved
// on (the button is disabled then anyway, but phase changes can land
// mid-click).
async function advanceFromOpeningSpeeches() {
  chairActionsStatusEl.textContent = "Starting Motion Raising…";
  try {
    // Shared with the AI-auto-advance driver in committee-data.js --
    // this button and that driver both just call the same core
    // function, so there's one copy of the actual phase-change logic.
    const applied = await advanceOpeningSpeechesPhase();
    chairActionsStatusEl.textContent = applied
      ? "Motion Raising has begun."
      : "The committee has already moved past Opening Speeches.";
  } catch (error) {
    console.error("Unable to begin Motion Raising:", error);
    chairActionsStatusEl.textContent = "Could not start Motion Raising -- check your connection and try again.";
  }
}

// Opens the country-by-country vote on whichever motion is currently
// raised -- only usable once a delegate has actually raised one.
async function openMotionVote() {
  chairActionsStatusEl.textContent = "Opening the vote…";
  try {
    // Shared with the AI-auto-advance driver -- see
    // advanceFromOpeningSpeeches above.
    const applied = await openRaisedMotionVote();
    chairActionsStatusEl.textContent = applied ? "The vote is open." : "There's no raised motion to vote on right now.";
  } catch (error) {
    console.error("Unable to open the motion vote:", error);
    chairActionsStatusEl.textContent = "Could not open the vote -- check your connection and try again.";
  }
}

// Approves whichever delegate's pending yield request is waiting --
// this is what actually moves the floor to the next human delegate (AI
// Delegates are skipped automatically); sending the request itself
// (see requestYield in committee.js) doesn't move anything on its own.
async function approveYieldRequest() {
  chairActionsStatusEl.textContent = "Approving yield…";
  try {
    const approvedCountry = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(committeeStateRef);
      if (!snapshot.exists()) {
        return null;
      }
      const data = snapshot.data();
      if (data.phaseIndex !== CAUCUS_DEBATE_PHASE_INDEX || !data.pendingYieldRequest) {
        return null;
      }
      const currentSpeakerIndex = data.currentSpeakerIndex ?? 0;
      transaction.update(committeeStateRef, {
        currentSpeakerIndex: findNextHumanSpeakerIndex(data.delegateRoles, currentSpeakerIndex + 1),
        pendingYieldRequest: null,
        updatedAt: serverTimestamp(),
      });
      return data.pendingYieldRequest.country;
    });

    if (approvedCountry) {
      chairActionsStatusEl.textContent = `${approvedCountry}'s yield was approved.`;
      logActivity("yield_approved", approvedCountry, `The Chair approved ${approvedCountry}'s request to yield.`);
    } else {
      chairActionsStatusEl.textContent = "There's no pending yield request right now.";
    }
  } catch (error) {
    console.error("Unable to approve the yield request:", error);
    chairActionsStatusEl.textContent = "Could not approve the yield -- check your connection and try again.";
  }
}

// Moves the committee on from Caucus / Debate to the drafting round of
// Resolution / Final Vote -- again, Chair-only, since nothing here is
// delegate-voted.
async function advanceFromCaucusDebate() {
  chairActionsStatusEl.textContent = "Moving to Resolution Drafting…";
  try {
    // Shared with the AI-auto-advance driver -- see
    // advanceFromOpeningSpeeches above.
    const applied = await beginResolutionDrafting();
    chairActionsStatusEl.textContent = applied
      ? "Resolution drafting has begun."
      : "The committee has already moved past Caucus / Debate.";
  } catch (error) {
    console.error("Unable to move to Resolution Drafting:", error);
    chairActionsStatusEl.textContent = "Could not move the committee along -- check your connection and try again.";
  }
}

// Opens the final Sign/Not Sign/Abstain vote -- only usable during the
// "drafting" half of Resolution / Final Vote. Locks the draft resolution
// for editing the moment this runs (see isResolutionEditablePhase in
// committee-data.js).
async function openFinalVote() {
  chairActionsStatusEl.textContent = "Opening the final vote…";
  try {
    // Shared with the AI-auto-advance driver -- see
    // advanceFromOpeningSpeeches above.
    const applied = await openFinalResolutionVote();
    if (applied) {
      chairActionsStatusEl.textContent = "The final vote is open.";
    } else {
      chairActionsStatusEl.textContent = "The final vote can only be opened during the drafting round.";
    }
  } catch (error) {
    console.error("Unable to open the final vote:", error);
    chairActionsStatusEl.textContent = "Could not open the final vote -- check your connection and try again.";
  }
}

startConferenceButton.addEventListener("click", () => {
  beginConference().catch((error) => console.error("Unable to start the conference:", error));
});

beginMotionsButton.addEventListener("click", () => {
  advanceFromOpeningSpeeches().catch((error) => console.error("Unable to begin Motion Raising:", error));
});

openMotionVoteButton.addEventListener("click", () => {
  openMotionVote().catch((error) => console.error("Unable to open the motion vote:", error));
});

approveYieldButton.addEventListener("click", () => {
  approveYieldRequest().catch((error) => console.error("Unable to approve the yield request:", error));
});

advanceToResolutionButton.addEventListener("click", () => {
  advanceFromCaucusDebate().catch((error) => console.error("Unable to move to Resolution Drafting:", error));
});

openFinalVoteButton.addEventListener("click", () => {
  openFinalVote().catch((error) => console.error("Unable to open the final vote:", error));
});

openReadinessCheckButton.addEventListener("click", () => {
  readinessCheckStatusEl.hidden = false;
  readinessCheckStatusEl.textContent = "Readiness check open -- waiting for delegates to click Proceed.";
  openReadinessCheck().catch((error) => {
    console.error("Unable to open the readiness check:", error);
    readinessCheckStatusEl.textContent = "Could not open the readiness check -- check your connection and try again.";
  });
});

// Renders everything on the dashboard from the latest committee/state
// document -- mirrors committee.js's renderCommitteeState, but
// read-only (no vote buttons, no message form) plus the topic-choice
// controls that only chair.js has.
function renderChairState(data) {
  const {
    phaseIndex,
    delegateRoles,
    votes,
    topicId,
    delegateAssignments,
    currentSpeakerIndex,
    raisedMotion,
    subStage,
    pendingYieldRequest,
    setupStage,
    conferenceNumber,
    delegateNames,
    rosterLocked,
    chairIsAi,
    topicConfirmedByChair,
    readyCountries,
    readyCheckOpen,
  } = data;
  const phaseName = COMMITTEE_PHASES[phaseIndex];
  const sessionComplete = phaseIndex === CONFERENCE_RESULTS_PHASE_INDEX;
  const currentTopic = getTopic(topicId);

  // The "Start Conference" roster lock: once clicked, the button
  // disappears for good and the status line explains what happened;
  // the AI-run badge only ever shows once chairIsAi is also true. See
  // lockRosterAndStart in committee-data.js for what set these fields.
  rosterLockButton.hidden = rosterLocked === true;
  if (rosterLocked) {
    rosterLockStatusEl.textContent = chairIsAi
      ? "Started -- nobody joined, so every seat (including the Chair) is AI-run."
      : "Started -- registration is closed and every unclaimed seat is now an AI Delegate.";
  }
  aiChairBadgeEl.hidden = !(rosterLocked && chairIsAi);

  // Keeps the AI-auto-advance timer running exactly while it should be
  // (chairIsAi and topicConfirmedByChair both true, and the committee
  // hasn't already finished) -- shared with committee.js so the same
  // loop runs no matter which page happens to be open (see
  // syncAiAutoAdvance in committee-data.js).
  syncAiAutoAdvance(data);

  phaseStepEl.textContent = `Phase ${phaseIndex + 1} of ${COMMITTEE_PHASES.length}`;
  phaseNameEl.textContent = phaseName;
  topicTextEl.textContent = currentTopic ? `Topic: ${currentTopic.name} — ${currentTopic.description}` : "No topic chosen yet.";

  // Topic-choice buttons: only usable during Conference Setup, and the
  // currently proposed one is picked out visually.
  const onSetup = phaseIndex === SETUP_PHASE_INDEX;
  topicChoiceListEl.hidden = !onSetup;
  topicChoiceNoteEl.hidden = onSetup;
  [...topicChoiceListEl.children].forEach((button) => {
    button.disabled = !onSetup;
    button.classList.toggle("topic-choice-current", button.dataset.topicId === topicId);
  });

  // Chair Controls: each button only ever appears during the one phase
  // it applies to.
  const awaitingConferenceStart = phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.AWAITING_START;
  startConferenceButton.hidden = !awaitingConferenceStart;
  startConferencePreviewEl.hidden = !(awaitingConferenceStart || (phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.GOAL_POLL));
  if (phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.GOAL_POLL && conferenceNumber != null) {
    startConferencePreviewEl.textContent = `Delegates now see: "${conferenceWelcomeMessage(conferenceNumber)}"`;
  } else if (awaitingConferenceStart) {
    startConferencePreviewEl.textContent = "Presence confirmed -- click Start Conference to send the welcome message and open the goal-agreement poll.";
  }

  beginMotionsButton.hidden = phaseIndex !== OPENING_SPEECHES_PHASE_INDEX;

  const onMotionRaising = phaseIndex === MOTION_RAISING_PHASE_INDEX;
  chairMotionStatusEl.hidden = !onMotionRaising;
  if (onMotionRaising) {
    chairMotionStatusEl.textContent = raisedMotion
      ? `Raised: ${MOTION_TYPES[raisedMotion.type] ?? raisedMotion.type} (by ${raisedMotion.raisedBy}).`
      : "No motion has been raised yet.";
  }
  openMotionVoteButton.hidden = !onMotionRaising;
  openMotionVoteButton.disabled = !raisedMotion;

  const draftingResolution = phaseIndex === RESOLUTION_VOTE_PHASE_INDEX && subStage === "drafting";
  openFinalVoteButton.hidden = !draftingResolution;

  // Only during Caucus / Debate: who's already yielded, who has the
  // floor right now, who's still waiting, and whichever yield request
  // is pending -- so the Chair knows who to call on and what to
  // approve next. Read-only roster (the Chair never yields on anyone's
  // behalf), unlike the matching panel on the delegate page.
  const onCaucusDebate = phaseIndex === CAUCUS_DEBATE_PHASE_INDEX;
  chairYieldCard.hidden = !onCaucusDebate;
  if (onCaucusDebate) {
    const speakerIndex = currentSpeakerIndex ?? 0;
    const allDone = speakerIndex >= COMMITTEE_COUNTRIES.length;
    const currentSpeaker = allDone ? null : COMMITTEE_COUNTRIES[speakerIndex];

    // Same running counter as the delegate page's Queue Order panel,
    // so the chair sees the exact same position numbers delegates do.
    let queuePosition = 0;

    chairYieldOrderListEl.replaceChildren(
      ...COMMITTEE_COUNTRIES.map((country, index) => {
        const row = document.createElement("li");
        const label = document.createElement("span");
        const status = document.createElement("span");

        row.className = "roster-row";
        label.textContent = formatDelegateLabel(country, delegateNames);
        status.className = "roster-role";

        if (delegateRoles[country] === "ai") {
          status.textContent = "AI Delegate";
        } else if (allDone || index < speakerIndex) {
          status.textContent = "Yielded to the Chair";
        } else if (country === currentSpeaker) {
          status.textContent = "Speaking now";
        } else {
          queuePosition += 1;
          status.textContent = `Position ${queuePosition} in queue`;
        }

        row.append(label, status);
        return row;
      }),
    );

    chairYieldRequestStatusEl.textContent = pendingYieldRequest
      ? `${pendingYieldRequest.country} asked to yield: “${pendingYieldRequest.message}”`
      : currentSpeaker
        ? `Waiting for ${currentSpeaker} to send a yield request.`
        : "Every delegate has had the floor.";
    approveYieldButton.hidden = !pendingYieldRequest;
  }

  // The Chair's "Open Readiness Check" button: in human-chaired
  // conferences, delegates informally agree in chat that they're ready
  // to move on, then the Chair opens this poll so they can formally
  // click Proceed on their own page. Purely informational for the
  // Chair -- opening it never gates or changes the behavior of
  // whichever existing advance button already moves the phase along.
  const readinessCheckPhaseQualifies =
    phaseIndex === OPENING_SPEECHES_PHASE_INDEX ||
    (onMotionRaising && Boolean(raisedMotion)) ||
    onCaucusDebate ||
    draftingResolution;
  const showReadinessCheck = !chairIsAi && readinessCheckPhaseQualifies;
  openReadinessCheckButton.hidden = !showReadinessCheck;
  if (showReadinessCheck) {
    const humanCountries = COMMITTEE_COUNTRIES.filter((country) => delegateRoles[country] === "human");
    const ready = readyCountries ?? {};
    readinessCheckStatusEl.hidden = false;
    if (!readyCheckOpen) {
      readinessCheckStatusEl.textContent =
        'Click "Open Readiness Check" once delegates have agreed in chat that they\'re ready to move on.';
    } else {
      const notReady = humanCountries.filter((country) => ready[country] !== true);
      const readyCount = humanCountries.length - notReady.length;
      readinessCheckStatusEl.textContent =
        notReady.length === 0
          ? `All ${humanCountries.length} human delegate(s) are ready. You can click the phase's advance button now.`
          : `${readyCount} of ${humanCountries.length} human delegate(s) ready. Waiting on: ${notReady.join(", ")}.`;
    }
  } else {
    readinessCheckStatusEl.hidden = true;
  }

  // Only three phases ever hold a vote at all -- hide the read-only
  // vote panel for every other phase instead of showing it empty.
  // Conference Setup only actually holds a vote during its roll_call
  // and goal_poll steps, not while just waiting on Start Conference.
  const votingNow =
    (phaseIndex === SETUP_PHASE_INDEX &&
      (setupStage === SETUP_STAGE.ROLL_CALL || setupStage === SETUP_STAGE.GOAL_POLL)) ||
    phaseIndex === MOTION_VOTING_PHASE_INDEX ||
    isFinalSigningVote(phaseIndex, subStage);
  chairVoteSectionEl.hidden = sessionComplete || !votingNow;

  if (votingNow) {
    const passingValue = isFinalSigningVote(phaseIndex, subStage) ? "sign" : "yes";
    const outcome = voteOutcome(votes, passingValue);
    const aiAutoChoice = isFinalSigningVote(phaseIndex, subStage) ? "sign" : "yes";
    const passCount = COMMITTEE_COUNTRIES.filter((country) => votes[country] === passingValue).length;

    voteSummaryEl.textContent =
      `${passCount} of ${COMMITTEE_COUNTRIES.length} voted ${VOTE_CHOICE_LABELS[passingValue]}` +
      ` (majority needs ${VOTE_THRESHOLD})` +
      (outcome === "failed" ? " -- this can no longer pass." : outcome === "passed" ? " -- this has passed." : ".");

    voteRowsEl.replaceChildren(
      ...COMMITTEE_COUNTRIES.map((country) => {
        const row = document.createElement("li");
        const label = document.createElement("span");
        const status = document.createElement("span");

        row.className = "vote-row";
        label.textContent = formatDelegateLabel(country, delegateNames);
        status.className = "vote-choice";

        if (delegateRoles[country] === "ai") {
          status.textContent =
            phaseIndex === SETUP_PHASE_INDEX && setupStage === SETUP_STAGE.ROLL_CALL
              ? "Present (AI, automatic)"
              : `${VOTE_CHOICE_LABELS[aiAutoChoice]} (AI, automatic)`;
        } else {
          const currentVote = votes[country];
          status.textContent = currentVote ? `Voted: ${VOTE_CHOICE_LABELS[currentVote] ?? currentVote}` : "Waiting to vote";
        }

        row.append(label, status);
        return row;
      }),
    );
  }

  // The roster: role plus, for human seats, whether a delegate has
  // actually claimed that country yet (uids aren't meaningful to show,
  // so this is just claimed/open).
  const claimedCountries = new Set(Object.values(delegateAssignments ?? {}));
  rosterListEl.replaceChildren(
    ...COMMITTEE_COUNTRIES.map((country) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      const role = document.createElement("span");

      row.className = "roster-row";
      label.textContent = formatDelegateLabel(country, delegateNames);
      role.className = "roster-role";
      role.textContent =
        delegateRoles[country] === "ai" ? "AI Delegate" : claimedCountries.has(country) ? "Human — claimed" : "Human — open seat";

      row.append(label, role);
      return row;
    }),
  );

  // The AI-speech dropdown only ever lists this session's AI Delegates
  // -- same restriction as the delegate page's version of this control.
  speechCountrySelect.replaceChildren(
    ...COMMITTEE_COUNTRIES.filter((country) => delegateRoles[country] === "ai").map((country) => {
      const option = document.createElement("option");
      option.value = country;
      option.textContent = country;
      return option;
    }),
  );

  // The same always-visible procedure timeline the delegate page shows.
  timelineBodyEl.replaceChildren(
    ...COMMITTEE_PHASES.map((name, index) => {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const descCell = document.createElement("td");
      const statusCell = document.createElement("td");

      nameCell.textContent = name;
      descCell.textContent = COMMITTEE_PHASE_DESCRIPTIONS[index];
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

      row.append(nameCell, descCell, statusCell);
      return row;
    }),
  );
}

// Builds the Play/Pause + Stop controls under a generated AI speech --
// identical behavior to the delegate page's version of this feature
// (see createAudioControls in committee.js), copied here so the chair's
// own speech-generation panel below can use it too.
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
  audio.addEventListener("play", () => {
    playPauseButton.textContent = "⏸ Pause";
    logActivity("speech_played", country, `${country}'s AI speech audio was played (chair panel).`);
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

// Shows one generated AI speech (text + playback controls) in the
// chair's own speech feed below the controls -- mirrors
// createMessageCard in committee.js, just always tagged "AI Delegate"
// since only AI speeches ever appear here.
function createSpeechCard(country, message, audioUrl) {
  const card = document.createElement("article");
  const countryName = document.createElement("span");
  const type = document.createElement("span");
  const messageText = document.createElement("p");

  card.className = "message";
  countryName.className = "message-country";
  type.className = "message-type";
  messageText.className = "message-text";
  countryName.textContent = country;
  type.textContent = "AI Delegate";
  messageText.textContent = `“${message}”`;

  card.append(countryName, type, messageText, createAudioControls(audioUrl, country));
  return card;
}

// Lets the chair generate and play any AI Delegate's speech directly
// from the dashboard -- the same feature the delegate page already
// offers (see generateAiSpeech in committee.js). Shown only on the
// chair's own screen and not broadcast to delegates, exactly like when
// a delegate generates one themselves.
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
  speechStatusEl.textContent = `Generating ${country}'s speech…`;
  logActivity(
    "speech_requested",
    country,
    `${country}'s AI speech was requested by the chair (voice: ${gender}, accent: ${useAccent ? "on" : "off"}).`,
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

    speechFeedEl.appendChild(createSpeechCard(delegate.country, delegate.speech, audioUrl));
    speechStatusEl.textContent = `${country}'s AI speech is ready below.`;
    logActivity("speech_ready", country, `${country}'s AI speech audio was generated for the chair.`);
  } catch (error) {
    console.error("Unable to generate AI speech:", error);
    speechStatusEl.textContent = error.message || "The speech could not be generated. Please try again.";
  } finally {
    speechButton.disabled = false;
  }
}

speechButton.addEventListener("click", generateAiSpeech);

// Subscribes to the live committee/state document for whichever session
// is currently active. Called once the dashboard first loads (after the
// chair's session code resolves), and again after starting a brand-new
// session, since that points committeeStateRef at a different document --
// unsubscribing the old listener first so a now-abandoned session
// doesn't leave a second, pointless listener running in the background.
let unsubscribeFromCommitteeState = null;

function startListeningToCommitteeState() {
  if (unsubscribeFromCommitteeState) {
    unsubscribeFromCommitteeState();
  }

  unsubscribeFromCommitteeState = onSnapshot(
    committeeStateRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        return;
      }
      setLatestCommitteeState(snapshot.data());
      renderChairState(latestCommitteeState);
    },
    (error) => {
      console.error("Unable to load the committee session state:", error);
    },
  );
}
