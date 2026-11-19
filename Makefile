LOCAL_BIN=./bin

$(LOCAL_BIN):
	mkdir -p $(LOCAL_BIN)

MDBOOK_VERSION ?= v0.5.2
MDBOOK_URL=https://github.com/rust-lang/mdBook/releases/download/$(MDBOOK_VERSION)/mdbook-$(MDBOOK_VERSION)-x86_64-unknown-linux-gnu.tar.gz

MERMAID_VERSION ?= v0.17.0
MERMAID_URL=https://github.com/badboy/mdbook-mermaid/releases/download/$(MERMAID_VERSION)/mdbook-mermaid-$(MERMAID_VERSION)-x86_64-unknown-linux-gnu.tar.gz

mdbook: $(LOCAL_BIN)
	test -f $(LOCAL_BIN)/mdbook || wget $(MDBOOK_URL) -O - | tar xz -C $(LOCAL_BIN) mdbook

mermaid: $(LOCAL_BIN)
	test -f $(LOCAL_BIN)/mdbook-mermaid || wget $(MERMAID_URL) -O - | tar xz -C $(LOCAL_BIN) mdbook-mermaid

gen-summary:
	cd src && \
	python3 ../tools/gen-summary.py  > ./SUMMARY.md

build: mdbook mermaid gen-summary
	rm -f ./book/latest_updates.html
	$(LOCAL_BIN)/mdbook build -d ./book

serve: mdbook mermaid gen-summary
	rm -f ./book/latest_updates.html
	$(LOCAL_BIN)/mdbook serve -d ./book
