import { addDoc, collection, db, ensureAnonymousUser, serverTimestamp } from "./firebase.js";

const feedbackForm = document.getElementById("feedback-form");
const feedbackStatus = document.getElementById("feedback-status");

// Saves community feedback so it can appear anonymously on the public opinions page.
feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const feedback = new FormData(feedbackForm).get("feedback").trim();

  if (!feedback) {
    feedbackStatus.textContent = "Please write your feedback before sending.";
    return;
  }

  const submitButton = feedbackForm.querySelector("button");
  submitButton.disabled = true;
  feedbackStatus.textContent = "Sending your feedback…";

  try {
    const user = await ensureAnonymousUser();
    await addDoc(collection(db, "feedback"), {
      authorId: user.uid,
      feedback,
      createdAt: serverTimestamp(),
    });
    feedbackForm.reset();
    feedbackStatus.textContent = "Thank you. Your feedback has been shared.";
  } catch (error) {
    console.error("Unable to save feedback:", error);
    feedbackStatus.textContent = "Your feedback could not be sent. Please try again.";
  } finally {
    submitButton.disabled = false;
  }
});
