document.addEventListener("DOMContentLoaded", () => {

    const button = document.getElementById("copy-link");

    if (!button) return;

    const toast = document.getElementById("copy-toast");

    button.addEventListener("click", async () => {

        try {

            await navigator.clipboard.writeText(button.dataset.url);

            button.classList.add("copied");

            toast.classList.add("show");

            setTimeout(() => {

                button.classList.remove("copied");

                toast.classList.remove("show");

            }, 1800);

        } catch (err) {

            console.error(err);

        }

    });

});
