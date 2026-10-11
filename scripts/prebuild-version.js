#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

const packageJsonPath = path.join(__dirname, "..", "package.json");
const appConfigPath = path.join(__dirname, "..", "app.config.ts");
const changelogPath = path.join(__dirname, "..", "changelog.json");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function question(prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, resolve);
    });
}

function loadChangelog() {
    try {
        if (fs.existsSync(changelogPath)) {
            return JSON.parse(fs.readFileSync(changelogPath, "utf8"));
        }
    } catch (error) {
        console.warn("Warning: Could not parse existing changelog.json, creating new one");
    }
    return { versions: [] };
}

function saveChangelog(changelog) {
    fs.writeFileSync(changelogPath, JSON.stringify(changelog, null, 4) + "\n");
}

async function collectFeatures() {
    const features = [];
    console.log("\n----------------------------------------");
    console.log("Enter new features for this version");
    console.log("(Enter each feature on a new line, empty line to finish)");
    console.log("----------------------------------------\n");

    while (true) {
        const feature = await question("Feature: ");
        if (feature.trim() === "") {
            break;
        }
        features.push(feature.trim());
    }

    return features;
}

async function main() {
    // Read current package.json
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const currentVersion = packageJson.version;

    console.log("\n========================================");
    console.log("  Prebuild with Version Update");
    console.log("========================================\n");
    console.log(`Current version: ${currentVersion}\n`);

    // Ask for new version
    const newVersion = await question(`Enter new version (leave empty to keep ${currentVersion}): `);
    const versionToUse = newVersion.trim() || currentVersion;

    // Validate version format (basic semver check)
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(versionToUse)) {
        console.error("\nError: Invalid version format. Use semver format (e.g., 1.2.3 or 1.2.3-beta.1)");
        rl.close();
        process.exit(1);
    }

    // Update package.json if version changed
    if (versionToUse !== currentVersion) {
        packageJson.version = versionToUse;
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 4) + "\n");
        console.log(`\nUpdated package.json version: ${currentVersion} -> ${versionToUse}`);
    } else {
        console.log(`\nKeeping version: ${versionToUse}`);
    }

    // Collect new features for changelog
    const features = await collectFeatures();

    // Update changelog.json
    if (features.length > 0) {
        const changelog = loadChangelog();
        const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD format

        // Check if this version already exists in changelog
        const existingVersionIndex = changelog.versions.findIndex((v) => v.version === versionToUse);

        if (existingVersionIndex >= 0) {
            // Append features to existing version entry
            changelog.versions[existingVersionIndex].features.push(...features);
            changelog.versions[existingVersionIndex].date = today;
            console.log(`\nAppended ${features.length} feature(s) to existing changelog entry for v${versionToUse}`);
        } else {
            // Add new version entry at the beginning
            changelog.versions.unshift({
                version: versionToUse,
                date: today,
                features: features,
            });
            console.log(`\nAdded new changelog entry for v${versionToUse} with ${features.length} feature(s)`);
        }

        saveChangelog(changelog);
        console.log("Updated changelog.json");
    } else {
        console.log("\nNo features entered, skipping changelog update");
    }

    // Generate Unix timestamp for versionCode
    const unixTimestamp = Math.floor(Date.now() / 1000);
    console.log(`Setting android versionCode: ${unixTimestamp}`);

    // Read and update app.config.ts
    let appConfig = fs.readFileSync(appConfigPath, "utf8");

    // Replace the versionCode value
    const versionCodeRegex = /versionCode:\s*\d+/;
    if (versionCodeRegex.test(appConfig)) {
        appConfig = appConfig.replace(versionCodeRegex, `versionCode: ${unixTimestamp}`);
        fs.writeFileSync(appConfigPath, appConfig);
        console.log("Updated app.config.ts versionCode");
    } else {
        console.error("\nWarning: Could not find versionCode in app.config.ts");
    }

    rl.close();

    // Run prebuild --clean
    console.log("\n----------------------------------------");
    console.log("Running: npx expo prebuild --clean");
    console.log("----------------------------------------\n");

    try {
        execSync("npx expo prebuild --clean", {
            stdio: "inherit",
            cwd: path.join(__dirname, ".."),
        });
        console.log("\n========================================");
        console.log("  Prebuild complete!");
        console.log(`  Version: ${versionToUse}`);
        console.log(`  Android versionCode: ${unixTimestamp}`);
        if (features.length > 0) {
            console.log(`  Changelog: ${features.length} new feature(s) added`);
        }
        console.log("========================================\n");
    } catch (error) {
        console.error("\nPrebuild failed:", error.message);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("Error:", error);
    rl.close();
    process.exit(1);
});
