// The chair dashboard: gated to the one Google account allowed to run
// this committee (see ALLOWED_CHAIR_EMAIL in firebase.js). Shows the
// same live committee state the delegate page does, but read-only --
// the chair doesn't vote or message -- plus one chair-only control:
// picking the Setting the Agenda topic directly instead of leaving it
// to the site's random proposal.
import { auth, db, isChairEmail, onAuthStateChanged, onSnapshot, runTransaction, serverTimestamp, signOut } from "./firebase.js";
import {
  COMMITTEE_PHASE_DESCRIPTIONS,
  COMMITTEE_TOPICS,
  COMMITTEE_COUNTRIES,
  getTopic,
  COMMITTEE_PHASES,
  TOPIC_PHASE_INDEX,
  PRESENCE_CHECK_PHASE_INDEX,
  YIELD_TIME_PHASE_INDEX,
  TOPIC_VOTE_DURATION_MS,
  VOTE_THRESHOLD,
  VOTE_CHOICE_LABELS,
  isSigningPhase,
  isTopicPhase,
  voteOutcome,
  committeeStateRef,
  latestCommitteeState,
  setLatestCommitteeState,
  initialVotesForPhase,
  logActivity,
  ensureCommitteeState,
  resolveActiveSessionCode,
  setActiveSessionCode,
  startNewSession,
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

const voteSummaryEl = document.getElementById("chair-vote-summary");
const voteRowsEl = document.getElementById("chair-vote-rows");

const chairYieldCard = document.getElementById("chair-yield-card");
const chairYieldOrderListEl = document.getElementById("chair-yield-order-list");

const rosterListEl = document.getElementById("roster-list");
const timelineBodyEl = document.getElementById("chair-timeline-body");

const resetSessionButton = document.getElementById("reset-session-button");
const resetSessionStatusEl = document.getElementById("reset-session-status");

// Only ever lets the one authorized Google account see the dashboard --
// everyone else (including someone not signed in at all) is sent back
// to the landing page. onAuthStateChanged fires once right away with
// whatever Firebase already knows, so there's no flash of the real
// dashboard before this check runs.
onAuthStateChanged(auth, (user) => {
  if (!isChairEmail(user)) {
    if (user) {
      // Signed in, but as the wrong account -- clear it before leaving
      // so a later "Sign in as Chair" click on the landing page shows
      // the Google account picker instead of silently reusing this one.
      signOut(auth).finally(() => {
        window.location.href = "join.html";
      });
    } else {
      window.location.href = "join.html";
    }
    return;
  }

  chairEmailEl.textContent = `Signed in as ${user.email}`;

  // Finds (or, the very first time ever, creates) this chair's current
  // meeting code before showing the real dashboard -- everything below
  // assumes committeeStateRef/committeeResolutionRef already point at
  // the right session, which only becomes true once this resolves.
  resolveActiveSessionCode()
    .then((code) => {
      setActiveSessionCode(code);
      sessionCodeEl.textContent = code;
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
  startNewSession()
    .then((code) => {
      sessionCodeEl.textContent = code;
      startListeningToCommitteeState();
      resetSessionStatusEl.textContent = `New session started. Meeting code: ${code}.`;
    })
    .catch((error) => {
      console.error("Unable to start a new committee session:", error);
      resetSessionStatusEl.textContent = "Could not start a new session -- check your connection and try again.";
    });
});

// Sets the Setting the Agenda topic directly to the chair's choice --
// resets the vote and the 60-second timer, just like an automatic
// reproposal does, but to a topic the chair picked instead of a random
// one. Does nothing if the committee has already moved past Setting
// the Agenda (the buttons are disabled then anyway, but phase changes
// can land mid-click).
async function chooseTopic(topicId) {
  topicChoiceStatusEl.textContent = "Setting topic…";
  try {
    const applied = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(committeeStateRef);
      if (!snapshot.exists()) {
        return false;
      }

      const data = snapshot.data();
      if (data.phaseIndex !== TOPIC_PHASE_INDEX) {
        return false;
      }

      transaction.update(committeeStateRef, {
        votes: initialVotesForPhase(data.delegateRoles, TOPIC_PHASE_INDEX),
        topicId,
        topicVoteAnonymous: {},
        topicVoteDeadlineMs: Date.now() + TOPIC_VOTE_DURATION_MS,
        updatedAt: serverTimestamp(),
      });
      return true;
    });

    if (applied) {
      topicChoiceStatusEl.textContent = `Topic set to "${getTopic(topicId)?.name}". The vote has been reset.`;
      logActivity("topic_chosen_by_chair", null, `The chair set the proposed topic to: ${getTopic(topicId)?.name}.`);
    } else {
      topicChoiceStatusEl.textContent = "The committee has already moved past Setting the Agenda.";
    }
  } catch (error) {
    console.error("Unable to set the topic:", error);
    topicChoiceStatusEl.textContent = "Could not set the topic -- check your connection and try again.";
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

// Renders everything on the dashboard from the latest committee/state
// document -- mirrors committee.js's renderCommitteeState, but
// read-only (no vote buttons, no message form) plus the topic-choice
// controls that only chair.js has.
function renderChairState(data) {
  const { phaseIndex, delegateRoles, votes, topicId, delegateAssignments, currentSpeakerIndex } = data;
  const phaseName = COMMITTEE_PHASES[phaseIndex];
  const onTopicPhase = isTopicPhase(phaseIndex);
  const passingValue = isSigningPhase(phaseIndex) ? "sign" : onTopicPhase ? "agree" : "yes";
  const outcome = voteOutcome(votes, passingValue);
  const currentTopic = getTopic(topicId);

  // Only during Yield Time: who's already yielded, who has the floor
  // right now, and who's still waiting -- so the chair knows who to
  // call on next. Read-only (the chair never yields on anyone's
  // behalf), unlike the matching panel on the delegate page.
  const onYieldPhase = phaseIndex === YIELD_TIME_PHASE_INDEX;
  chairYieldCard.hidden = !onYieldPhase;
  if (onYieldPhase) {
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
        label.textContent = country;
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
  }

  phaseStepEl.textContent = `Phase ${phaseIndex + 1} of ${COMMITTEE_PHASES.length}`;
  phaseNameEl.textContent = phaseName;
  topicTextEl.textContent = currentTopic
    ? `${onTopicPhase ? "Proposed" : "Adopted"} topic: ${currentTopic.name} — ${currentTopic.description}`
    : "No topic proposed yet.";

  // Topic-choice buttons: only usable during Setting the Agenda, and
  // the currently proposed one is picked out visually.
  const onSettingAgenda = phaseIndex === TOPIC_PHASE_INDEX;
  topicChoiceListEl.hidden = !onSettingAgenda;
  topicChoiceNoteEl.hidden = onSettingAgenda;
  [...topicChoiceListEl.children].forEach((button) => {
    button.disabled = !onSettingAgenda;
    button.classList.toggle("topic-choice-current", button.dataset.topicId === topicId);
  });

  // The live vote tally -- no buttons, this is read-only.
  const aiAutoChoice = onTopicPhase ? "agree" : isSigningPhase(phaseIndex) ? "sign" : "yes";
  const passCount = COMMITTEE_COUNTRIES.filter((country) => votes[country] === passingValue).length;
  voteSummaryEl.textContent =
    `${passCount} of ${COMMITTEE_COUNTRIES.length} voted ${VOTE_CHOICE_LABELS[passingValue]}` +
    ` (majority needs ${VOTE_THRESHOLD})` +
    (outcome === "failed" ? " -- this motion can no longer pass." : outcome === "passed" ? " -- this has passed." : ".");

  voteRowsEl.replaceChildren(
    ...COMMITTEE_COUNTRIES.map((country) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      const status = document.createElement("span");

      row.className = "vote-row";
      label.textContent = country;
      status.className = "vote-choice";

      if (delegateRoles[country] === "ai") {
        status.textContent =
          phaseIndex === PRESENCE_CHECK_PHASE_INDEX
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
      label.textContent = country;
      role.className = "roster-role";
      role.textContent =
        delegateRoles[country] === "ai" ? "AI Delegate" : claimedCountries.has(country) ? "Human — claimed" : "Human — open seat";

      row.append(label, role);
      return row;
    }),
  );

  // The same always-visible procedure timeline the delegate page shows.
  const sessionComplete = isSigningPhase(phaseIndex) && outcome === "passed";
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
