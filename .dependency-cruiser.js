import preset from "@hussmartinez/sdk-config/dependency-cruiser";

/**
 * The family's preset, plus ai-core's own layer rules (AGENTS.md): the core
 * never imports the server or the testing tools, and adapters never import
 * the server. The preset doesn't know these folders, because only ai-core
 * has them.
 */
export default {
  ...preset,
  forbidden: [
    ...(preset.forbidden ?? []),
    {
      name: "ai-core-core-not-outer",
      comment: "The core never imports the server or the testing tools (ai-core AGENTS.md).",
      severity: "error",
      from: { path: "(?:^|/)src/core/" },
      to: { path: "(?:^|/)src/(?:server|testing)/" },
    },
    {
      name: "ai-core-adapters-not-server",
      comment: "Adapters never import the server (ai-core AGENTS.md).",
      severity: "error",
      from: { path: "(?:^|/)src/adapters/" },
      to: { path: "(?:^|/)src/server/" },
    },
  ],
};
