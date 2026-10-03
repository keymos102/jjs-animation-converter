// js/app.js

"use strict";

const fileInput = document.getElementById("rbxmFile");
const output = document.getElementById("output");
const tree = document.getElementById("tree");

if (!fileInput) {
    console.error("Не найден input #rbxmFile");
}

fileInput?.addEventListener("change", async (event) => {

    const file = event.target.files[0];

    if (!file) {
        return;
    }

    output.textContent = "Читаю RBXM...";

    tree.innerHTML = "";

    try {

        const buffer = await file.arrayBuffer();

        console.log("RBXM file:", file.name);
        console.log("Size:", buffer.byteLength);

        const result = RBXM.parse(buffer);

        console.log("RBXM parsed:", result);

        output.textContent =
            `Файл: ${file.name}\n` +
            `Размер: ${buffer.byteLength} байт\n` +
            `Instances: ${result.instances.size}\n` +
            `Корневых объектов: ${result.roots.length}`;

        // -------------------------------------------------
        // Показываем дерево
        // -------------------------------------------------

        for (const root of result.roots) {
            tree.appendChild(
                createTreeElement(root)
            );
        }

        // -------------------------------------------------
        // Ищем анимации
        // -------------------------------------------------

        const animation =
            RBXM.extractAnimation(
                result.roots[0]
            );

        console.log(
            "Extracted animation:",
            animation
        );

    } catch (error) {

        console.error(error);

        output.textContent =
            "Ошибка:\n" +
            error.message;

    }
});


// =========================================================
// Создание дерева
// =========================================================

function createTreeElement(instance) {

    const container =
        document.createElement("div");

    container.className =
        "rbxm-tree-node";

    const line =
        document.createElement("div");

    line.className =
        "rbxm-tree-line";

    line.textContent =
        `${instance.className}  |  ${instance.name}`;

    container.appendChild(line);

    if (instance.children.length > 0) {

        const children =
            document.createElement("div");

        children.className =
            "rbxm-tree-children";

        for (const child of instance.children) {

            children.appendChild(
                createTreeElement(child)
            );
        }

        container.appendChild(children);
    }

    return container;
}