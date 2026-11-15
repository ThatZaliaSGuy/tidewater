# Vehicle engine recordings

Reused from the user's Swift Parking game. Copyright remains with the original
recordists; these excerpts are incorporated into this game, not a sample pack.
The source records and processed SHA-256 hashes are in `sources.json`.

- `jeep-hemi.ogg`: Pole Position, Dodge Ram 1500 HEMI SUV 2014 recording,
  Sonniss GDC 2020 bundle. A real HEMI V8 sound used as the lifted Jeep's engine;
  it is not represented as an exact recording of this custom vehicle.
- `aster-inline-six.ogg`: Pole Position, BMW M4 2014 recording,
  Sonniss GDC 2020 bundle, used for the Aster coupe.

The two engine loops ship as Ogg Vorbis (q6) encodes of those processed 22.05 kHz mono loops, not
as the WAV recordings: game assets only, never a redistributable copy of the bundle sounds. They decode
to the same 42,336 samples as the WAVs, so the loop seam is unchanged. The `sha256` values in
`sources.json` are those of the processed WAV loops the encodes were made from.

Swift Parking processed stable excerpts into seamless mono loops with DC removal,
level matching and an equal-power loop seam. Tidewater uses the same recordings
with modest RPM-dependent pitch changes and throttle-dependent gain/filtering.

[Sonniss GDC Bundle License 2.0](https://sonniss.com/gdc-bundle-license/)
and [official bundle catalogue](https://gdc.sonniss.com/gdc-game-audio-bundle/).

# Voice

- `yeet.wav`: "Yeet Sound" by sukondi, [Freesound #553805](https://freesound.org/people/sukondi/sounds/553805/),
  Creative Commons 0. Trimmed to the voice, faded and peak-normalised to -1 dBFS.
