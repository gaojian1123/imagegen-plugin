---
name: imagegen-config
description: >
  Use when the user asks to set up or configure imagegen, or when generate_image
  or edit_image reports missing AZURE_OPENAI settings.
---

# Configure imagegen

Use Copilot CLI's native MCP editor. Tell the user to run:

```text
/mcp edit imagegen
```

In **Environment Variables**, enter one of these JSON objects.

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

Press **Ctrl+S**, then retry the image request.

- Never ask the user to paste an API key into chat; they must enter it directly
  in the MCP editor.
- Require the full v1 endpoint ending in `/openai/v1`.
- Omit `AZURE_OPENAI_API_KEY` for Entra ID. The signed-in identity needs the
  **Cognitive Services OpenAI User** role.
