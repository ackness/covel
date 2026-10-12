### Added

- **The showcase website tells a visitor how to open the unsigned app.** Under the download button there is now a note for the visitor's system. On macOS, which reports the build as "damaged" after a browser download, it gives the command that removes the quarantine attribute: `xattr -dr com.apple.quarantine /Applications/Covel.app`. On Windows, where SmartScreen shows "Windows protected your PC", it names the two clicks: "More info", then "Run anyway".
