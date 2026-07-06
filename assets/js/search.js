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

    async function runSearch() {

        const query = input.value.trim();

        results.innerHTML = "";

        if (query.length < 2)
            return;

        const search = await pagefind.search(query);

        if (!search.results.length) {

            results.innerHTML = `
                <p class="search-empty">
                    No essays matched your search.
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

        for (const result of search.results) {

            const data = await result.data();

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

            card.querySelector(".search-result__reading-time")
                .textContent = `${data.meta.reading_time} min read`;

            card.querySelector(".search-result__description")
                .textContent =
                    data.meta.description ||
                    data.excerpt.replace(/<[^>]+>/g, "");

            const excerpt = data.excerpt.trim();

            card.querySelector(".search-result__excerpt")
            .innerHTML = `… ${excerpt} …`;

            results.appendChild(card);

        }

    }

});
