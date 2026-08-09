const form = document.getElementById("settingsForm");
const providerSelect = document.getElementById("provider");
const aiBaseUrlInput = document.getElementById("aiBaseUrl");
const aiModelInput = document.getElementById("aiModel");
const aiApiKeyInput = document.getElementById("aiApiKey");
const supadataApiKeyInput = document.getElementById("supadataApiKey");
const providerHelp = document.getElementById("providerHelp");
const saveStatus = document.getElementById("saveStatus");
const dataStatus = document.getElementById("dataStatus");

document.addEventListener("DOMContentLoaded", loadSettings);
providerSelect.addEventListener("change", updateProviderFields);
form.addEventListener("submit", saveSettings);
document
  .getElementById("clearCacheBtn")
  .addEventListener("click", clearCachedDigests);
document
  .getElementById("clearNotesBtn")
  .addEventListener("click", clearNotes);
document.getElementById("resetBtn").addEventListener("click", resetAllData);

async function loadSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  const settings = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);

  providerSelect.value = settings.provider;
  aiBaseUrlInput.value = settings.aiBaseUrl || YTD_SETTINGS.DEFAULTS.aiBaseUrl;
  aiModelInput.value = settings.aiModel || YTD_SETTINGS.DEFAULTS.aiModel;
  aiApiKeyInput.value = settings.aiApiKey;
  supadataApiKeyInput.value = settings.supadataApiKey;
  updateProviderFields();
}

function updateProviderFields() {
  const isDeepSeek = providerSelect.value === "deepseek";
  aiBaseUrlInput.disabled = isDeepSeek;
  aiModelInput.disabled = isDeepSeek;

  if (isDeepSeek) {
    aiBaseUrlInput.value = YTD_SETTINGS.DEFAULTS.aiBaseUrl;
    aiModelInput.value = YTD_SETTINGS.DEFAULTS.aiModel;
    providerHelp.innerHTML =
      'DeepSeek uses <code>https://api.deepseek.com</code> and <code>deepseek-v4-flash</code>.';
  } else {
    providerHelp.textContent =
      "Enter an OpenAI-compatible base URL and model identifier. HTTPS is required except for localhost.";
  }
}

async function saveSettings(event) {
  event.preventDefault();
  saveStatus.textContent = "Saving…";

  try {
    const settings = YTD_SETTINGS.normalize({
      provider: providerSelect.value,
      aiBaseUrl: aiBaseUrlInput.value,
      aiModel: aiModelInput.value,
      aiApiKey: aiApiKeyInput.value,
      supadataApiKey: supadataApiKeyInput.value,
    });

    if (!settings.supadataApiKey) {
      throw new Error("Add a Supadata API key.");
    }
    if (!settings.aiApiKey) {
      throw new Error("Add an AI provider API key.");
    }
    if (!settings.aiModel) {
      throw new Error("Add an AI model identifier.");
    }

    YTD_SETTINGS.chatCompletionsUrl(settings.aiBaseUrl);

    if (settings.provider === "custom") {
      const origin = YTD_SETTINGS.permissionPattern(settings.aiBaseUrl);
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        throw new Error(`Host access was not granted for ${origin}`);
      }
    }

    const previousStored = await chrome.storage.local.get(
      YTD_SETTINGS.STORAGE_KEY,
    );
    const previousSettings = YTD_SETTINGS.normalize(
      previousStored[YTD_SETTINGS.STORAGE_KEY],
    );

    await chrome.storage.local.set({
      [YTD_SETTINGS.STORAGE_KEY]: settings,
    });

    if (previousSettings.provider === "custom") {
      const previousOrigin = YTD_SETTINGS.permissionPattern(
        previousSettings.aiBaseUrl,
      );
      const nextOrigin =
        settings.provider === "custom"
          ? YTD_SETTINGS.permissionPattern(settings.aiBaseUrl)
          : null;
      if (previousOrigin !== nextOrigin) {
        await chrome.permissions.remove({ origins: [previousOrigin] });
      }
    }

    saveStatus.textContent = "Saved. Reopen YT Digest to use these settings.";
  } catch (error) {
    saveStatus.textContent = error.message;
  }
}

async function clearCachedDigests() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith("digest_"));
  if (keys.length) await chrome.storage.local.remove(keys);
  dataStatus.textContent = `Cleared ${keys.length} cached digest${keys.length === 1 ? "" : "s"}.`;
}

async function clearNotes() {
  await chrome.storage.local.remove("ytd_notes");
  dataStatus.textContent = "Deleted all saved notes.";
}

async function resetAllData() {
  const confirmed = window.confirm(
    "Delete API keys, cached digests, translations, and saved notes from this Chrome profile?",
  );
  if (!confirmed) return;

  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  const settings = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
  await chrome.storage.local.clear();
  if (settings.provider === "custom") {
    await chrome.permissions.remove({
      origins: [YTD_SETTINGS.permissionPattern(settings.aiBaseUrl)],
    });
  }
  await loadSettings();
  dataStatus.textContent = "All YT Digest data was deleted.";
}
