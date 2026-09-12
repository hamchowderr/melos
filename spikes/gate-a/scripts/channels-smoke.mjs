// Install + import smoke for packages the spike does not exercise at runtime.
const results = [];

async function check(name, probe) {
  try {
    const detail = await probe();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error).slice(0, 200) });
  }
}

await check("@copilotkit/channels", async () => {
  const m = await import("@copilotkit/channels");
  if (typeof m.createChannel !== "function") throw new Error("createChannel missing");
  return "createChannel, defineChannelTool";
});
await check("@copilotkit/channels/slack", async () => {
  const m = await import("@copilotkit/channels/slack");
  if (typeof m.slack !== "function") throw new Error("slack adapter missing");
  return "slack()";
});
await check("@copilotkit/react-ui", async () => {
  const m = await import("@copilotkit/react-ui");
  return Object.keys(m).filter((k) => /CopilotChat|CopilotSidebar/.test(k)).join(", ");
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} - ${r.detail}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
