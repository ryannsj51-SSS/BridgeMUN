// The signed-in user's own personal page -- this is now the ONE place
// a Google account creates or joins a conference, picks Chair or
// Delegate (and, as a Delegate, a country and a name), all without
// ever leaving this page. Earlier this flowed through a separate
// a separate lobby page after creating or joining, which meant a
// second full page load and a second Firestore fetch right after the
// first one -- if that second fetch ever stalled, the visitor was
// stuck on a blank "Checking meeting code..." screen with no way out.
// Keeping everything here, in memory, after the first successful
// create/join avoids that failure mode entirely.
import { auth, isGoogleUser, onAuthStateChanged, onSnapshot, signOut } from "./firebase.js";
import {
  COMMITTEE_COUNTRIES,
  committeeStateRef,
  createOwnedConference,
  ensureCommitteeState,
  formatDelegateLabel,
  joinSessionByCode,
  claimDelegateSeat,
} from "./committee-data.js";

const checkingCard = document.getElementById("checking-card");
const dashboard = document.getElementById("my-page-dashboard");
const emailEl = document.getElementById("my-page-email");
const signOutButton = document.getElementById("sign-out-button");

const startSection = document.getElementById("start-section");
const createButton = document.getElementById("create-button");
const joinCodeForm = document.getElementById("join-code-form");
const joinCodeInput = document.getElementById("join-code-input");
const joinStatusEl = document.getElementById("join-status");

const conferenceSection = document.getElementById("conference-section");
const sessionCodeEl = document.getElementById("session-code");
const alreadyJoinedBanner = document.getElementById("already-joined-banner");
const roleChoiceEl = document.getElementById("role-choice");
const chairRoleButton = document.getElementById("chair-role-button");
const delegateRoleButton = document.getElementById("delegate-role-button");
const delegateForm = document.getElementById("delegate-form");
const delegateCountrySelect = document.getElementById("delegate-country");
const delegateNameInput = document.getElementById("delegate-name");

// The active conference's code, once Step 1 (create or join) succeeds
// -- everything in Step 2 reads this instead of a URL parameter, since
// there's no second page here.
let activeCode = null;
let latestStateData = null;
let currentUser = null;
let stopListening = null;

// Only ever lets a real Google account see this page -- a delegate's
// anonymous identity, or nobody signed in at all, is sent back to the
// sign-in page instead. onAuthStateChanged fires once right away with
// whatever Firebase already knows, so there's no flash of the real
// page before this check runs.
onAuthStateChanged(auth, (user) => {
  currentUser = user;

  if (!isGoogleUser(user)) {
    window.location.href = "join.html";
    return;
  }

  emailEl.textContent = `Signed in as ${user.email}`;
  checkingCard.hidden = true;
  dashboard.hidden = false;
  renderRoleChoice();
});

signOutButton.addEventListener("click", () => {
  signOut(auth)
    .then(() => {
      window.location.href = "join.html";
    })
    .catch((error) => console.error("Sign-out failed:", error));
});

// Switches from Step 1 (create/join) to Step 2 (the code plus
// Chair/Delegate) once a conference is actually active -- called right
// after a successful create or a successful join, never on its own.
function showConferenceSection(code) {
  activeCode = code;
  sessionCodeEl.textContent = code;
  startSection.hidden = true;
  joinStatusEl.textContent = "";
  conferenceSection.hidden = false;

  // Live updates (e.g. another delegate claiming a country right
  // before this visitor finishes picking their own) -- a fresh
  // listener each time a new conference becomes active, with the
  // previous one (if any) stopped first so two conferences' updates
  // can never mix.
  if (stopListening) {
    stopListening();
  }
  stopListening = onSnapshot(
    committeeStateRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        joinStatusEl.textContent = "This conference was reset -- ask its chair for a current code.";
        return;
      }
      latestStateData = snapshot.data();
      renderRoleChoice();
    },
    (error) => {
      console.error("Unable to load this conference:", error);
      joinStatusEl.textContent = "Could not load this conference. Please refresh and try again.";
    },
  );
}

// Fills in the Chair/Delegate choice (and, once a role is picked, the
// country list) from whatever is currently known -- safe to call
// before either the conference data or the auth state has arrived yet,
// and again any time afterward.
function renderRoleChoice() {
  if (!activeCode || !latestStateData) {
    return;
  }

  const myAssignment = currentUser ? latestStateData.delegateAssignments?.[currentUser.uid] : null;
  const amOwner = isGoogleUser(currentUser) && currentUser.uid === latestStateData.ownerUid;

  chairRoleButton.hidden = !amOwner;

  // Already claimed a seat in this conference (most often: this
  // visitor reloaded the page after already joining) -- show a plain
  // confirmation plus a direct link into the room instead of the
  // picker.
  if (myAssignment) {
    const label = formatDelegateLabel(myAssignment, latestStateData.delegateNames);
    alreadyJoinedBanner.hidden = false;
    alreadyJoinedBanner.innerHTML = "";
    const line = document.createElement("strong");
    line.textContent = `You're already in this committee as ${label}.`;
    const link = document.createElement("a");
    link.href = "delegate.html";
    link.textContent = "Continue to the committee room";
    alreadyJoinedBanner.append(line, link);
    roleChoiceEl.hidden = true;
    delegateForm.hidden = true;
    return;
  }

  alreadyJoinedBanner.hidden = true;
  roleChoiceEl.hidden = false;

  // The Chair has already clicked "Start Conference" -- registration
  // is closed, so there's nothing left to pick a country for (the
  // Chair option above is untouched, since locking the roster doesn't
  // stop the owner from entering their own dashboard).
  if (latestStateData.rosterLocked) {
    delegateRoleButton.hidden = true;
    delegateForm.hidden = true;
    joinStatusEl.textContent = "Registration for this conference has closed -- the chair already started it.";
    return;
  }
  delegateRoleButton.hidden = false;

  // Only still-open, human-run seats -- the same rule claimDelegateSeat
  // enforces server-side, mirrored here so the picker never even shows
  // an option that would fail.
  const takenCountries = new Set(Object.values(latestStateData.delegateAssignments ?? {}));
  const availableCountries = COMMITTEE_COUNTRIES.filter(
    (country) => latestStateData.delegateRoles?.[country] === "human" && !takenCountries.has(country),
  );

  delegateCountrySelect.replaceChildren(
    ...availableCountries.map((country) => {
      const option = document.createElement("option");
      option.value = country;
      option.textContent = country;
      return option;
    }),
  );

  const noSeatsLeft = availableCountries.length === 0;
  delegateRoleButton.disabled = noSeatsLeft;
  delegateRoleButton.textContent = noSeatsLeft ? "Enter as Delegate (no open seats)" : "Enter as Delegate";
}

// Creates a brand-new conference owned by this account, then reveals
// its code and the role choice right here -- see showConferenceSection
// above.
createButton.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!isGoogleUser(user)) {
    return;
  }

  createButton.disabled = true;
  joinCodeForm.querySelector("button").disabled = true;
  joinStatusEl.textContent = "Creating your conference…";

  try {
    const code = await createOwnedConference(user.uid);
    showConferenceSection(code);
  } catch (error) {
    console.error("Unable to create a new conference:", error);
    // Surfaces the real Firebase error code (e.g. "permission-denied"
    // if the deployed Firestore rules are out of date) instead of a
    // generic message, so a stale deploy is obvious from the page
    // itself rather than only from the browser console.
    joinStatusEl.textContent = `Could not create a conference (${error.code ?? error.message ?? "unknown error"}) -- check your connection and try again.`;
    createButton.disabled = false;
    joinCodeForm.querySelector("button").disabled = false;
  }
});

// Joins an existing conference by its meeting code -- same Step 2 as
// creating one, just arrived at a different way.
joinCodeForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const code = joinCodeInput.value.trim();
  if (!/^[0-9]{6}$/.test(code)) {
    joinStatusEl.textContent = "Enter the 6-digit code exactly as it was shared with you.";
    return;
  }

  createButton.disabled = true;
  const submitButton = joinCodeForm.querySelector("button");
  submitButton.disabled = true;
  joinStatusEl.textContent = "Checking code…";

  try {
    const joined = await joinSessionByCode(code);
    if (!joined) {
      joinStatusEl.textContent =
        "That code isn't active right now -- check it and try again, or ask whoever shared it for a current one.";
      createButton.disabled = false;
      submitButton.disabled = false;
      return;
    }
    await ensureCommitteeState();
    showConferenceSection(code);
  } catch (error) {
    console.error("Unable to check the meeting code:", error);
    joinStatusEl.textContent = "Could not check that code -- check your connection and try again.";
    createButton.disabled = false;
    submitButton.disabled = false;
  }
});

chairRoleButton.addEventListener("click", () => {
  if (!activeCode) {
    return;
  }
  window.location.href = `chair.html?code=${activeCode}`;
});

delegateRoleButton.addEventListener("click", () => {
  const opening = delegateForm.hidden;
  delegateForm.hidden = !opening;
  delegateRoleButton.classList.toggle("role-button-selected", opening);
});

delegateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeCode) {
    return;
  }

  const country = delegateCountrySelect.value;
  const name = delegateNameInput.value.trim();
  if (!country || !name) {
    joinStatusEl.textContent = "Please choose a country and type a name.";
    return;
  }

  const submitButton = delegateForm.querySelector("button");
  submitButton.disabled = true;
  joinStatusEl.textContent = "Joining the committee…";

  try {
    await claimDelegateSeat(activeCode, country, name);
    localStorage.setItem("mun-session-code", activeCode);
    window.location.href = "delegate.html";
  } catch (error) {
    console.error("Unable to join as a delegate:", error);
    const reason = error?.message;
    joinStatusEl.textContent =
      reason === "taken"
        ? "Someone else just claimed that country -- pick another one."
        : reason === "not_available"
          ? "That country isn't a human seat this session -- pick another one."
          : reason === "locked"
            ? "Registration for this conference has closed -- the chair already started it."
            : "Could not join right now -- check your connection and try again.";
    submitButton.disabled = false;
  }
});
