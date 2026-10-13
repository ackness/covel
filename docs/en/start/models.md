# Connect a model

Covel does not come with a model. This page walks you through adding a provider, entering a key, testing the connection, and confirming that every role has a model available. When you finish, the world's session-prep screen no longer warns that a model is missing.

## Before you start

You need one of the following:

- An API key from a model provider, such as DeepSeek, OpenAI, Anthropic, Google Gemini, or Alibaba Cloud Bailian (Qwen).
- A local or self-hosted model service that is compatible with the OpenAI API.

The model must support **tool calling** (function calling). Covel's plugins rely on tool calls to update states such as quests and the inventory. A model that does not support tool calls cannot move the game forward.

> [!IMPORTANT]
> The provider charges for model calls based on usage, and you pay that cost through your own account. Covel does not handle or pay these charges.

## Three terms to know first

| Term         | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| **Provider** | A model endpoint: one address, plus the key used to access it                                               |
| **Model**    | A model ID under a provider                                                                                 |
| **Role**     | A kind of work in Covel, for example writing the story text (`story`) or a plugin updating state (`plugin`) |

First you add providers and models. Then you tell Covel which model each role uses. For a first try, it is enough for every role to share one text model.

## 1. Add a provider and models

Open **Settings → LLM → Providers & Models**.

1. Pick a built-in provider from the list, or add a custom provider. A built-in provider already has its official address. A custom provider needs an API address.
2. Enter the API key. For a local service that needs no key, you can leave it empty.
3. Add the model ID. Type it the way the provider itself writes it. Covel sends it unchanged.
   - A provider that serves its own models uses a plain name, for example `qwen3.8-flash`. Do not put a vendor name in front of it.
   - Only a gateway that relays models of several vendors (for example OpenRouter) uses the `vendor/model-name` form, for example `openai/gpt-5.6-sol`. Enter all of it, the `/` included.

You set up the address and key once for each provider. Then you can add several models under that provider.

## 2. Test the connection

In the provider's details, click the test button ("Test connectivity and latency") for the model you just added. A successful test shows the latency.

When a test fails, first look at what kind of problem it reports:

| What the error says             | Usual cause                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Authentication failed           | The key is wrong, or the key does not have permission for this model                            |
| Model not found                 | The model ID is spelled differently from the provider's name                                    |
| Connection timed out or refused | The address is wrong, or you need a proxy (set it under **Settings → Desktop → Network Proxy**) |

## 3. Check the role assignments

Open **Settings → LLM → Model Roles**. This lists the provider and model that each role uses now.

- Make sure both the story-text role and the plugin role use the model you just tested successfully.
- Later, to save money or get faster replies, you can switch the plugin role to a cheaper, faster model and keep a stronger model for the story role.

Changes take effect right away. You do not need to restart.

## Confirm it works

Go back to the world selection page, and click "Enter" on any world card. The session-prep screen checks which roles this world's gameplay needs:

- No warning appears: the models are ready, and you can start your [first game](./first-session.md).
- A warning says a role is not available: go back to "Model Roles" and choose a model for it. Or, in "Customize plugins and advanced settings" on the session-prep screen, change that task to use a role that is already set up.

## You have a subscription but no API key

A subscription such as ChatGPT and an API are two different things. The subscription lets you chat in the service's own app, and Covel needs an API. With only a subscription, Covel cannot use it directly yet.

To play with a subscription, you can use a third-party converter such as [Magpie](https://github.com/yetone/magpie). A tool of this kind turns your subscription into an API address, and you then add that address to Covel as a custom provider:

1. Install the tool and sign in as its own instructions say. Note the API address it gives you, and the key if it has one.
2. Go back to [step 1](#1-add-a-provider-and-models) above. Add a custom provider, enter that address and key, and add the model IDs it supports.
3. Test the connection as in [step 2](#2-test-the-connection).

> [!IMPORTANT]
> Tools such as Magpie are third-party software. Covel does not develop or maintain them. Whether one works, how stable it is, and whether it fits the terms of your subscription are for the tool and the service to say. Problems that come from using them are not Covel's; report them to the tool's author.
>
> Covel may support signing in with a subscription directly later. It does not yet.

## Where keys are stored

- Desktop app: stored in plain text in `~/.covel/keys.env`. The file permissions allow only the current user to read it.
- Web version: stored in the local storage of the current browser.

## Learn more

For the full list of roles, the fallback rules, and how to write `llm.toml`, see the [model role reference](../reference/slots.md).

## Next

[Your first game](./first-session.md)
