// The role-selection landing page: sends a visitor either into the
// Google-gated chair dashboard or straight into the delegate committee
// page (which assigns them a country on its own).
import { auth, isChairEmail, signInWithGoogle, signOut } from "./firebase.js";

const chairButton = document.getElementById("chair-button");
const delegateButton = document.getElementById("delegate-button");
const chairStatusEl = document.getElementById("chair-status");

// Joining as a delegate needs no sign-in here -- but every committee
// session now lives behind its own 6-digit meeting code (see
// join-code.html), so this goes there next instead of straight into the
// committee page.
delegateButton.addEventListener("click", () => {
  window.location.href = "join-code.html";
});

// Signs in with Google, then only continues to the chair dashboard if
// it's the one account allowed to use it -- anyone else is signed back
// out immediately and told why, right here, instead of letting them
// land on chair.html and bounce back.
chairButton.addEventListener("click", async () => {
  chairStatusEl.textContent = "";
  chairButton.disabled = true;

  try {
    // Already signed in as the right account from an earlier visit --
    // no need to show the Google popup again.
    let user = isChairEmail(auth.currentUser) ? auth.currentUser : await signInWithGoogle();

    if (isChairEmail(user)) {
      window.location.href = "chair.html";
      return;
    }

    await signOut(auth);
    chairStatusEl.textContent =
      "That Google account isn't authorized as chair. Try a different Google account, or join as a delegate instead.";
  } catch (error) {
    console.error("Chair sign-in failed:", error);
    chairStatusEl.textContent = "Sign-in was cancelled or failed. Please try again.";
  } finally {
    chairButton.disabled = false;
  }
});
