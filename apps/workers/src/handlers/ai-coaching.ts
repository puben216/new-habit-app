import { getAiCoachingDeps } from "../ai-coaching-container";
import { createAiCoachingHandler } from "../ai-coaching-handler";

/** Lambda entry point(`ai-coaching` queue の consumer)。 */
export const handler = createAiCoachingHandler(getAiCoachingDeps);
