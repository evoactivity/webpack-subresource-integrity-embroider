const { JSDOM } = require("jsdom");
const { readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");

class SubresourceIntegrityPlugin {
  async getResourceContent(resourcePath) {
    if (resourcePath.startsWith("http")) {
      const response = await fetch(resourcePath);
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    return readFile(resourcePath);
  }

  generateExternalResourceError(fileName, hashAlgorithm, fileHash, element) {
    element.setAttribute("integrity", `${hashAlgorithm}-${fileHash}`);
    element.setAttribute("crossorigin", "anonymous");

    const text = `\x1b[31m\n🚨 The ${fileName} resource is served from an external URL and does not contain an integrity hash. We have hashed the file as it exists today, we don't automatically apply this so you can detect when an external resource has been changed.

If you trust the file please update the resource as follows in your index.html:

${element.outerHTML}`;

    element.removeAttribute("integrity");
    element.removeAttribute("crossorigin");

    return text;
  }

  async generateHash(hashAlgorithm, resourceLocation) {
    return createHash(hashAlgorithm)
      .update(await this.getResourceContent(resourceLocation))
      .digest("base64");
  }

  apply(compiler) {
    compiler.hooks.done.tapPromise(
      "WriteSRIToIndexHtmlPlugin",
      async (stats) => {
        const { outputPath, publicPath } = stats.toJson();
        const indexHtmlPath = path.join(outputPath, "index.html");
        const indexHtmlContent = await readFile(indexHtmlPath, "utf-8");
        const indexHtml = new JSDOM(indexHtmlContent);
        const scriptElements =
          indexHtml.window.document.querySelectorAll("script");
        const linkElements = indexHtml.window.document.querySelectorAll("link");
        const fileErrors = [];
        await Promise.all(
          [...scriptElements, ...linkElements].map(async (element) => {
            // calculate integrity
            const hashAlgorithm = "sha384";
            const assetLocation =
              element.tagName === "SCRIPT"
                ? element.getAttribute("src")
                : element.getAttribute("href");
            // strip publishPath from locations
            const fileName = assetLocation.replace(publicPath, "/");
            const currentIntegrity = element.getAttribute("integrity");

            if (fileName === "/ember-cli-live-reload.js") {
              // ember-cli-live-reload.js does not exist on disk
              return;
            }

            if (fileName.startsWith("http")) {
              if (currentIntegrity) return;
              const fileHash = await this.generateHash(hashAlgorithm, fileName);

              fileErrors.push(
                this.generateExternalResourceError(
                  fileName,
                  hashAlgorithm,
                  fileHash,
                  element,
                ),
              );

              return;
            }

            const filePath = path.join(outputPath, fileName);
            const fileHash = await this.generateHash(hashAlgorithm, filePath);

            // set integrity attribute
            element.setAttribute("integrity", `${hashAlgorithm}-${fileHash}`);
            // set crossorigin attribute
            element.setAttribute("crossorigin", "anonymous");
          }),
        );

        if (fileErrors.length > 0) {
          throw new Error(fileErrors.join("\n\n------\n"));
        }

        await writeFile(indexHtmlPath, indexHtml.serialize());
      },
    );
  }
}

module.exports = SubresourceIntegrityPlugin;
