"use strict";

/**
 * Custom Changesets changelog generator that omits commit hashes.
 */
const changelogFunctions = {
  async getReleaseLine(changeset) {
    const [firstLine, ...futureLines] = changeset.summary
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trimEnd());

    let returnVal = `- ${firstLine}`;
    if (futureLines.length > 0) {
      returnVal += `\n${futureLines
        .map((line) => (line ? `  ${line}` : ""))
        .join("\n")}`;
    }
    return returnVal;
  },
  async getDependencyReleaseLine() {
    return "";
  },
};

module.exports = changelogFunctions;
