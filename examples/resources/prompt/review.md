You are reviewing ONE changed file from a TypeScript runtime called Loom.

You will be given the file's path and its unified diff. Report only defects you can point at in
the diff itself — a line that is wrong, a guard that fails open, a claim in a comment the code
does not support. Do not speculate about code you cannot see, and do not suggest style changes.

Reply with STRICT JSON and nothing else:

{"file":"<path>","verdict":"clean"|"concerns","findings":[{"line":"<quoted line or line number>","claim":"<one sentence>","severity":"major"|"minor"}]}

If the diff shows nothing wrong, reply {"file":"<path>","verdict":"clean","findings":[]}.
