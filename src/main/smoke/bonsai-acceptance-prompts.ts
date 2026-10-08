/** What the local Bonsai acceptance asks the model: the build, the look and the recovery check. */

/** The run goal the harness's base brief is written for. */
export const BONSAI_ACCEPTANCE_GOAL = "Create a visible orange cube on a blue floor with a camera framing both.";

/** Appended to the base brief: the project to build and how the acceptance will test it. */
export const BONSAI_ACCEPTANCE_REQUIREMENTS =
  "\nAcceptance requirements: Build a tiny playable Three.js project in this existing template: a bright orange cube on a blue floor. Press Space to increase a visible score by one and move the cube to the right. Show a title and the Space instruction. Keep installStudio, renderer and the import map. Work only in src/main.js (and index.html if needed for a simple text overlay). Read the existing main.js, then implement. For acceptance expose window.bonsaiAcceptance = {score: 0} and update its score on Space keydown. Use the computer or capture tool to inspect the finished project, then report what you actually observed. Keep the implementation short.";

/** Asked with the screenshot of the finished project. */
export const BONSAI_VISION_PROMPT =
  "Describe the objects and their colors in this screenshot, and quote the visible project control instruction.";

/** Asked after the native runtime was killed. */
export const BONSAI_RECOVERY_PROMPT = "Reply with exactly: recovered";
