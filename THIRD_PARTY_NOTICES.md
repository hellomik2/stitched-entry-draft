# Third-party data and notices

The code in this repository is under the [MIT License](LICENSE). The data files below come from
outside sources and keep their own terms.

## U.S. Harmonized Tariff Schedule (USITC)

- File: `data/hts/2026HTSRev23-subset.json` (33 rows, headings 3926.40, 6913.90, 7013.99, 9405.50,
  9505.90).
- Source: U.S. International Trade Commission, HTS 2026 Revision 23,
  `https://hts.usitc.gov/reststop/exportList`, fetched 2026-11-17.
- Terms: work of the U.S. federal government.

## CBP port code tables (Schedule D, Schedule K)

- Files: `data/codes/schedule-d.json`, `data/codes/schedule-k.json`. Each file names its source PDF,
  edition and extraction method in its header fields.
- Source: U.S. Customs and Border Protection, ACE M1 Import Manifest appendices E and F.
- Terms: U.S. government work published by CBP; public domain per the CBP copyright notice
  (`https://www.cbp.gov/site-policy-notices/copyright-notice`).

## Unicode CLDR (country names)

- File: `data/codes/iso-3166-1.json`. The English region names come from Unicode CLDR 48.0 as
  shipped in ICU 78.2 with Node.js 20.20.2; a few aliases were added by hand (listed in the file).
- Terms: Unicode License v3. The text below matches https://www.unicode.org/license.txt as read
  on 2026-11-26.

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

## Invented sample documents

Every company, person, address, vessel and number in `samples/` and `public/samples/` is invented
for this project and marked DEMO / FICTITIOUS or SAMPLE / FICTIONAL.
