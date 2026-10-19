# Transfer speed, 1.0.0 to 1.9.0, through a WAN-like link

Every version ran from its own commit behind a TCP relay that adds 15 ms each way (30 ms round trip) and caps each
connection at 60 MB/s. The client used the same protocol as the web page (init, chunk PUTs with 3 in flight,
complete; files one after another).

| version | upload 1 x 300 MB | upload 100 x 200 KB | download 300 MB | share-link download 300 MB |
|---|---|---|---|---|
| 1.0.0 | 72.2 MB/s | 1.9 MB/s | 59.6 MB/s | - |
| 1.2.0 | 108.2 MB/s | 1.9 MB/s | 59.6 MB/s | - |
| 1.5.0 | 107.1 MB/s | 1.9 MB/s | 59.6 MB/s | 59.5 MB/s |
| 1.7.0 | 106.7 MB/s | 1.9 MB/s | 59.5 MB/s | 59.6 MB/s |
| 1.7.2 | 105.4 MB/s | 1.9 MB/s | 59.6 MB/s | 59.6 MB/s |
| 1.8.0 | 106.7 MB/s | 1.9 MB/s | 59.5 MB/s | 59.6 MB/s |
| 1.8.2 | 106.9 MB/s | 1.9 MB/s | 59.6 MB/s | 59.6 MB/s |
| 1.9.0 | 107.2 MB/s | 1.9 MB/s | 59.6 MB/s | 59.6 MB/s |

No version is slower than an earlier one: big files fill the link (downloads hit the 60 MB/s cap). The weak spot is
many small files, sent one at a time so each waits for its round trips. 1.9.1 uploads up to 3 files at once with
one shared limit of chunk requests (default 6): in Chromium behind a 30 ms relay, 60 small files went from 8.2 s to
3.1 s, and 7 visitor-link files from 1.26 s to 0.61 s.
