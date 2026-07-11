---
name: imagegen-config
description: >
  Use when the user asks to set up or configure imagegen, or when generate_image
  or edit_image reports missing AZURE_OPENAI settings.
---

# Configure imagegen

Use the setup path for the current host.

## GitHub Copilot CLI

Tell the user to open the native MCP editor:

```text
/mcp edit imagegen
```

## OpenAI Codex

Tell the user to set the variables below in the environment that launches
Codex, then restart Codex. Do not use `/mcp edit` in Codex.

## Values

Use one of these environment variable sets.

For Microsoft Entra ID:

```json
{
  "AZURE_OPENAI_ENDPOINT": "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
  "AZURE_OPENAI_IMAGE_DEPLOYMENT": "gpt-image-2"
}
```

For API-key authentication:

```json
{
  "AZURE_OPENAI_ENDPOINT": "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
  "AZURE_OPENAI_IMAGE_DEPLOYMENT": "gpt-image-2",
  "AZURE_OPENAI_API_KEY": "YOUR-KEY"
}
```

In Copilot CLI, enter the selected object under **Environment Variables** and
press **Ctrl+S**. In Codex, use the same names and values in the local process
environment. Then retry the image request.

- Never ask the user to paste an API key into chat; they must enter it directly
  in the MCP editor or their local environment.
- Require the full v1 endpoint ending in `/openai/v1`.
- Omit `AZURE_OPENAI_API_KEY` for Entra ID. The signed-in identity needs the
  **Cognitive Services OpenAI User** role.
