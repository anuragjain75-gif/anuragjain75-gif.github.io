window.addEventListener("DOMContentLoaded", async () => {

    const input = document.getElementById("search-input");
    const results = document.getElementById("search-results");
    const template = document.getElementById("search-result-template");

    if (!input || !results || !template) return;

    await pagefind.init();

    let timer;

    input.addEventListener("input", () => {

        clearTimeout(timer);

        timer = setTimeout(runSearch, 200);

    });

    function escapeRegex(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    async function runSearch() {

        const query = input.value.trim();

        results.innerHTML = "";

        if (query.length < 2)
            return;

        const search = await pagefind.search(query);

        if (!search.results.length) {

            results.innerHTML = `
                <p class="search-empty">
                    Nothing in The Lilamaya matched your search.
                </p>
            `;

            return;
        }

        const typeMap = {
            "Essays": "Essay",
            "Books": "Book",
            "Fragments": "Fragment",
            "Pages": "Page"
        };

        const wholeWord = new RegExp(
            `\\b${escapeRegex(query.toLowerCase())}\\b`,
            "i"
        );

        let matches = 0;

        for (const result of search.results) {

            const data = await result.data();

            const searchableText = [
                data.meta.title || "",
                data.meta.description || "",
                data.excerpt || ""
            ].join(" ").toLowerCase();

            // Ignore fuzzy matches like "moments" for "moon"
            if (!wholeWord.test(searchableText)) {
                continue;
            }

            matches++;

            const card = template.content.cloneNode(true);

            const link = card.querySelector(".search-result__link");

            link.href = data.url;
            link.textContent = data.meta.title || data.url;

            const contentType =
                typeMap[data.meta.type] ||
                data.meta.type ||
                "Page";

            card.querySelector(".search-result__type")
                .textContent = contentType;

            const meta = card.querySelector(".search-result__reading-time");

            if (contentType === "Fragment") {

                if (data.meta.date) {

                    meta.textContent = new Date(data.meta.date)
                        .toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "long",
                            year: "numeric"
                        });

                } else {

                    meta.textContent = "";

                }

            } else {

                meta.textContent = `${data.meta.reading_time} min read`;

            }

            card.querySelector(".search-result__description")
                .textContent =
                    data.meta.description ||
                    data.excerpt.replace(/<[^>]+>/g, "");

            card.querySelector(".search-result__excerpt")
                .innerHTML = `… ${data.excerpt.trim()} …`;

            results.appendChild(card);

        }

        if (matches === 0) {

            results.innerHTML = `
                <p class="search-empty">
                    Nothing in The Lilamaya matched your search.
                </p>
            `;

        }

    }

});
