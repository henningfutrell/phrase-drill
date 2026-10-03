# server/certs

`supabase-prod-ca.crt` is the Supabase root CA that signs the TLS certificate of
every hosted Supabase Postgres (session pooler `*.pooler.supabase.com`, direct
`*.supabase.co`). `server/db.js#sslConfigFor` hands it to `pg`, which verifies
the chain and the hostname. It is a public certificate, not a secret.

Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

```
subject=C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA
issuer =C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA
notBefore=Apr 28 10:56:53 2021 GMT
notAfter =Apr 26 10:56:53 2031 GMT
sha256 Fingerprint=80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
```

Before cutover: compare this fingerprint with the certificate offered in the
project's dashboard (Project Settings -> Database -> SSL -> Download
certificate). If they differ, replace the file with the dashboard's.

Check: `openssl x509 -noout -subject -issuer -dates -fingerprint -sha256 -in server/certs/supabase-prod-ca.crt`

Expires 2031-04-26; replace it before then. The Dockerfile runtime stage copies
`server/`, so this directory ships in the image.
