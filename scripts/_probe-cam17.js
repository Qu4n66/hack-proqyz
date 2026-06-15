import { readFileSync } from "node:fs";
import { QuizSchema } from "../src/domain/schemas.js";
const raw = readFileSync("fixtures/cam17-reading-test01-passage1.json", "utf8");
const parsed = JSON.parse(raw);
const r = QuizSchema.safeParse(parsed);
if (!r.success) {
  console.error(JSON.stringify(r.error.issues, null, 2));
  process.exit(1);
}
console.log("ok");
