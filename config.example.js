/**
 * CONFIG TEMPLATE — Copy this file to "config.js" and add your own API keys.
 *
 * Setup:
 *   1. Duplicate this file and rename the copy to "config.js"
 *   2. Paste your API keys into the empty strings below
 *   3. Reload the extension at chrome://extensions
 *
 * Your real config.js is git-ignored, so your keys never get committed.
 *
 * HOW TO GET YOUR KEYS:
 *
 * 1. SUPADATA API KEY (for fetching YouTube transcripts)
 *    - Go to: https://supadata.ai
 *    - Sign up for a free account (100 free requests, no credit card)
 *    - Go to your dashboard and copy your API key
 *
 * 2. ANTHROPIC API KEY (for Claude AI analysis)
 *    - Go to: https://console.anthropic.com/settings/keys
 *    - Sign up or log in
 *    - Click "Create Key" and copy it (starts with sk-ant-)
 *
 * 3. DEEPSEEK API KEY (for cheap transcript enhancement)
 *    - Go to: https://platform.deepseek.com/
 *    - Sign up and add some credits ($2-5 is plenty)
 *    - Go to API Keys and create a new key
 *    - Copy the key (starts with sk-)
 *
 * 4. ASSEMBLYAI API KEY (for transcribing videos that don't have subtitles)
 *    - Go to: https://www.assemblyai.com/dashboard/signup
 *    - Sign up for a free account (includes free tier hours)
 *    - Go to your Dashboard — your API key is shown right on the home page
 *    - Copy it and paste it below
 */

const CONFIG = {
  // Paste your Supadata API key here (get it at https://supadata.ai)
  SUPADATA_API_KEY: '',

  // Paste your Anthropic API key here (get it at https://console.anthropic.com)
  ANTHROPIC_API_KEY: '',

  // Paste your DeepSeek API key here (get it at https://platform.deepseek.com/api_keys)
  DEEPSEEK_API_KEY: '',

  // Paste your AssemblyAI API key here (get it at https://www.assemblyai.com/dashboard)
  ASSEMBLYAI_API_KEY: '',

  // (OPTIONAL) Custom cobalt API URL for downloading YouTube audio.
  // Leave empty to use the built-in list of public instances.
  // If you self-host cobalt (recommended for reliability), put your instance URL here.
  // Example: 'https://my-cobalt-instance.com'
  COBALT_API_URL: '',
};
