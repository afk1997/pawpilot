import { resolve } from "node:path";
import { DEFAULT_WORKBOOK_PATH, printValidationReport, workbookSummary } from "./common";
import { parseWorkbook } from "../../src/lib/kb/parse-workbook";
import { validateParsedWorkbook } from "../../src/lib/kb/validate-workbook";

const workbookPath = resolve(process.argv[2] ?? DEFAULT_WORKBOOK_PATH);
const parsed = parseWorkbook(workbookPath);
const report = validateParsedWorkbook(parsed);

console.log(`Workbook: ${workbookPath}`);
console.log(JSON.stringify(workbookSummary(parsed), null, 2));
printValidationReport(report);

if (report.errors.length > 0) {
  process.exitCode = 1;
}
