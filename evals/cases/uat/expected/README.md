# Expected citations for the UAT question pack (R-08)

| File | What | Who fills it |
| --- | --- | --- |
| `<owner>__<name>.json` | one entry per question of `../questions.json` for that repository: `expectedPaths` (files a correct answer cites) and `expectedSymbols` (qualified names); `labelled_by` / `labelled_at` set by the person who read the code | a person; the runner scaffolds the file with empty expectations and `labelled_by: null` and never fills it |
| scoring | once labelled, `uat:run` scores each answer by recall of the expected paths and symbols among what it cited; below 0.5 the answer is classed `missed` | `app/assistant/uat.ts` |
