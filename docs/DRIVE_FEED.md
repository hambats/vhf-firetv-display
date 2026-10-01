# Google Drive feed — photos and flyers from social media

A shared Google Drive folder that VHF's social media lead fills in and the
display picks up by itself. Code: [sources/drive/index.mjs](../sources/drive/index.mjs).
It runs inside the daily **sync content** GitHub Actions workflow; the
television never talks to Google.

**Anything put in this folder ends up on a public website.** The display is a
public GitHub Pages site, the same as the farm's gallery photos. Treat the
folder like a social media post: only what you would be happy to post publicly.

## For Maddie — how to use it

```
VHF TV Display/
  Classes/
    Pottery/
    Wreath Making/
    Beeswax Candles/
    ...one folder per class
  Flyers/
  Farm Photos/
```

- **Classes.** Make a folder named for the class and drop photos in it. Use
  the name the calendar uses: a folder called *Beeswax Candles* shows its
  photos behind the calendar event *Beeswax Candles with Jessica*. Words like
  "Class", "Workshop" and "Photos" in the folder name are ignored. Folders
  inside a class folder (for example *Pottery/October*) count as that class.
- **Flyers.** Designed graphics, such as the ones made for Instagram. They are
  shown whole, never cropped, on their own slide. **Put the last day in the
  file name** and the flyer stops showing after that day: `wreath 11-21.png`,
  `2026-11-21 wreath.png` and `Wreath 11.21.png` all run through
  November 21. A flyer with no date shows for 30 days after it is added.
- **Farm Photos.** Anything else from around the farm. These join the
  general photo rotation.
- **Captions (optional).** Right-click a photo → *File information* →
  *Details* and type a description. It is shown as a line under the photo.
- **Removing something.** Delete it from the folder. It leaves the display
  on the next sync.

New photos appear the day after they are added. The sync runs every morning.
Phone photos are fine as they are: iPhone HEIC files, sideways photos and very
large files are all handled, and the phone's location data is stripped. Videos
and very small images (under 1000 pixels on the long side) are skipped.

## One-time setup (Rob)

1. **The folder.** In your Google Drive, create `VHF TV Display` with
   the three subfolders above. *Share* → *General access* → **Anyone with the
   link → Viewer**. Add Maddie as an **Editor**. The folder ID is the last part
   of its address: `drive.google.com/drive/folders/<this part>`.
2. **An API key.** This lets the sync read the folder reliably. It is not a
   password, and it can only read files that are already public.
   - <https://console.cloud.google.com> → create a project (e.g. *VHF Display*).
   - *APIs & Services* → *Library* → **Google Drive API** → *Enable*.
   - *APIs & Services* → *Credentials* → *Create credentials* → **API key**.
   - Edit the key → *API restrictions* → **Restrict key** → *Google Drive API*
     only. Leave *Application restrictions* at *None*, because GitHub's
     runners have no fixed address.
3. **GitHub secrets.** Repo → *Settings* → *Secrets and variables* →
   *Actions*: add `DRIVE_FOLDER_ID` and `DRIVE_API_KEY`. Or from this repo:

   ```bash
   gh secret set DRIVE_FOLDER_ID
   ```
   ```bash
   gh secret set DRIVE_API_KEY
   ```
4. **First run.** *Actions* → *sync content* → *Run workflow* with *dry run*
   ticked. The run summary lists what was found, added and skipped, and why.
   Then run it again without *dry run*.

Until both secrets exist the Drive step skips and everything else syncs as
before.

## How it behaves

- **Drive is the source of truth for what it contributes.** Images are
  mirrored into `content/artwork/drive/`, and
  `content/generated/drive.json` records what came from where. Never
  hand-edit either one. Hand-curated photos in `content/artwork/curated/` are
  untouched. A Drive class folder whose name matches an existing program
  (*Pottery* → `program-pottery`) adds to that program's photos rather than
  replacing them.
- **Images come through Drive's own thumbnail renderer at 1920px**, not as
  originals. That converts HEIC, applies rotation, keeps the files small, and
  re-encodes without EXIF, so GPS never reaches the site. Unchanged photos are
  not fetched again.
- **A class folder is also a calendar keyword.** It is checked after the
  hand-written table in `sources/calendar/index.mjs`, which wins wherever the
  two disagree.
- **Failures are loud but contained.** If Drive fails (sharing changed, key
  revoked), the last good Drive content stays up, the calendar and gallery
  still publish, and the run ends red. If Drive suddenly reports an empty
  folder that had photos the day before, the sync fails instead of blanking
  every Drive-fed slide. `DRIVE_ALLOW_EMPTY=1` overrides that if the folder
  really was emptied.
- **On the television**, Drive images get their own Service Worker cache,
  capped at 200 images. A flyer past its date is hidden by the display itself
  even if a sync has not run.

## Known limits

- Drive photos have no face-aware crop focus. They use the default
  upper-middle crop.
- A folder for the 5K or the Hendersonville Women's Club adds to a set the
  display treats as a single designed graphic or logo, so a photo there would
  be shown as one. Don't make class folders for those two.
- Shortcuts inside the folder are not followed. Copy the file in instead.
