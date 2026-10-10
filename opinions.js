import { collection, db, getDocs } from "./firebase.js";

const opinionsFeed = document.getElementById("opinions-feed");
const opinionsStatus = document.getElementById("opinions-status");

// Loads public feedback once when the page opens, keeping anonymous user IDs hidden.
async function loadOpinions() {
  try {
    const snapshot = await getDocs(collection(db, "feedback"));
    const opinions = snapshot.docs
      .map((document) => document.data())
      .sort((first, second) => {
        const firstTime = first.createdAt?.toMillis?.() ?? 0;
        const secondTime = second.createdAt?.toMillis?.() ?? 0;
        return secondTime - firstTime;
      });

    opinionsFeed.replaceChildren(
      ...opinions.map((opinionData) => {
        const opinion = document.createElement("article");
        opinion.className = "opinion";
        opinion.textContent = opinionData.feedback;
        return opinion;
      }),
    );
    opinionsStatus.textContent = opinions.length
      ? ""
      : "No opinions yet, be the first one to leave one!";
  } catch (error) {
    console.error("Unable to load community opinions:", error);
    opinionsStatus.textContent = "Opinions could not be loaded. Please refresh and try again.";
  }
}

loadOpinions();
