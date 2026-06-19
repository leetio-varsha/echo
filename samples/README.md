# samples/

Test audio for the Phase 1 pipeline. Audio files here are gitignored.

Generate a quick multilingual clip (macOS):

```bash
./samples/make-sample.sh        # writes samples/test.m4a
```

Then run the pipeline against it:

```bash
node pipeline/src/index.js samples/test.m4a --dry-run
```
