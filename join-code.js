// The delegate-side "enter the meeting code" step -- sits between
// join.html's "Join as Delegate" button and delegate.html itself, since
// every committee session now lives behind its own 6-digit code instead
// of the whole site sharing one permanent committee.
import { joinSessionByCode } from "./committee-data.js";

const form = document.getElementById("join-code-form");
const codeInput = document.getElementById("code-input");
const statusEl = document.getElementById("join-code-status");
const submitButton = form.querySelector("button");

// Only digits, and only up to six of them, as the visitor types -- the
// code is numeric, so there's no reason to let anything else in.
codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = codeInput.value.trim();

  if (!/^[0-9]{6}$/.test(code)) {
    statusEl.textContent = "Enter the 6-digit code exactly as your chair shared it.";
    return;
  }

  submitButton.disabled = true;
  statusEl.textContent = "Checking code…";

  try {
    const joined = await joinSessionByCode(code);
    if (!joined) {
      statusEl.textContent =
        "That code isn't active right now -- check it and try again, or ask your chair for the current one.";
      submitButton.disabled = false;
      return;
    }

    // delegate.html re-checks this same code itself on load (a fresh
    // page load means committee-data.js's in-memory session is gone),
    // so this is really just handing it along -- see committee.js.
    localStorage.setItem("mun-session-code", code);
    window.location.href = "delegate.html";
  } catch (error) {
    console.error("Unable to check the meeting code:", error);
    statusEl.textContent = "Could not check that code -- check your connection and try again.";
    submitButton.disabled = false;
  }
});
