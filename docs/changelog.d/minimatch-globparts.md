### Security

- **Desktop packaging no longer carries a minimatch release affected by the glob-pattern amplification advisory.** The macOS universal-app merge and the template file lister used by electron-builder now resolve minimatch 11.0.2 instead of 9.0.9 and 5.1.9. The remaining minimatch 3 copies inside electron-builder predate the pattern preprocessing that the advisory concerns.
