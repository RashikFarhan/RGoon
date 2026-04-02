export const manifest = {
    id: "com.stashio.bridge",
    version: "1.0.0",
    name: "Stashio",
    description: "Bridge between StashDB and public torrent providers",
    resources: ["catalog", "meta", "stream"],
    types: ["movie"],
    catalogs: [
        {
            type: "movie",
            id: "stash_scenes",
            name: "Stash Scenes",
            extra: [
                { name: "genre", isRequired: false },
                { name: "developer", isRequired: false }
            ]
        }
    ],
    behaviorHints: {
        configurable: true,
        configurationRequired: true,
        configurationUrl: "http://localhost:7000/configure" // Placeholder configuration URL
    }
};
