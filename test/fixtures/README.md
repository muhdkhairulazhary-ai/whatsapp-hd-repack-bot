# Dolby Vision 8.4 regression fixture

`dolby-vision-84.mov` is a synthetic five-frame blue portrait clip with an AAC stereo sine tone. It contains no user media. The HLG base layer was encoded with FFmpeg and x265 at 1080×1920 and 60 fps. The HEVC access units include a type 62 RPU NAL carrying the Profile 8.4 RPU test vector from `quietvoid/dovi_tool` at revision `41dae646193c12de152333ff5dbc33579cb9ef4a` (`assets/tests/profile84.bin`). The MOV uses an `hvc1` sample description and a `dvvC` record declaring profile 8, level 8, compatibility ID 4, RPU and base layer present, and no enhancement layer. The upstream test vector license is included here.

The fixture is for checking transport and metadata, including RPU retention. Its synthetic picture and reused RPU are unsuitable for judging Dolby Vision color rendering.
