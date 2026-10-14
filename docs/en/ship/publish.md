# Publish and update

The easiest way to share is to put your work on GitHub. Other people can install it by pasting one link, and they can check for updates later. This page explains how to host it, how others install it, and what happens when you release a new version.

## 1. Put it on GitHub

Push the plugin or world to a **public** GitHub repository. Both of these layouts work:

```text
One package per repository      Several packages in one repository
my-plugin/                      my-covel-stuff/
├── PLUGIN.md                   ├── plugins/
├── package.json                │   ├── tavern-rumors/
└── ...                         │   └── another-plugin/
                                └── worlds/
                                    └── tidelamp/
```

A few limits:

- The repository must be public. A private repository cannot be installed.
- The code in the package must run as soon as it is installed. Covel does not install dependencies or run a build during installation.
- The plugin's `package.json` cannot have `dependencies`. Put any code you use directly in the package. Covel provides the plugin SDK and `zod`; if you need them while developing, list them under `devDependencies`.

## 2. How others install it

The other person opens **Settings → Install & manage** and pastes the link. The link you give decides what they get:

| The link you give           | What they get                     | Can they check for updates later?  |
| --------------------------- | --------------------------------- | ---------------------------------- |
| The repository address      | What is on the default branch now | Yes. It follows the default branch |
| A link to a branch          | What is on that branch now        | Yes. It follows that branch        |
| A link to a tag or a commit | That one fixed version            | No. It is locked to this version   |

If you want users to always get the latest version, give the repository address. If you want users to install one specific version, give a link to a tag.

A link can point all the way to a subfolder, so the other person only sees that one package.

## 3. Release a new version

1. After your changes are done, raise the version number in both `PLUGIN.md` and `package.json`.
2. Run the [tests](./test.md) and a [trial install](./package.md).
3. Push to GitHub.

Users are not updated automatically. A user has to click "Check for updates" in the installed list, see which files changed, and confirm. The update takes effect after the backend restarts.

Two things about updates are worth knowing:

- **The user's data is not touched.** An update only replaces the files in the package. Saves, the data a plugin stored, and settings all stay. So a new version must be able to read the data that an old version stored.
- **A package the user has changed is not overwritten.** If the user has edited files in the package, the update is stopped.

## 4. Help more people find it

To get your work listed in the official directory, submit an entry to the matching repository:

- [Plugin directory](https://github.com/covel-ai/covel-plugins)
- [World directory](https://github.com/covel-ai/covel-worlds)

Your code stays in your own repository, and the directory only points to it. For how to submit, see the contribution guide in each repository.

> [!NOTE]
> Being listed in a directory does not mean the code has passed a security review. When users install your plugin, they still see the code risk notice, and the first run still needs authorization.

## If you do not want to use GitHub

Send the ZIP you made during a [trial install](./package.md) directly to the other person. They import it on the same page. A package installed this way has no source record, so it cannot check for updates. You have to send each new version again.

## Learn more

- [All the rules for plugin installation](../reference/plugin-installation.md): link formats, size limits, and update details.
- [All the rules for world package installation](../reference/world-installation.md)
- [Trust boundaries of community plugins](../internals/security.md)

## Next step

Do you want to release a world together with the plugins it needs? See [collections](./collections.md).
