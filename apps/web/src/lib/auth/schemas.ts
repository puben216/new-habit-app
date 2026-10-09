import { z } from "zod";

/** 本文の内容を使わない 2xx 応答(`202`/`200`)。object であることだけを確認する。 */
export const acknowledgedSchema = z.looseObject({});
