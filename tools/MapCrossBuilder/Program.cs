using System.Globalization;
using System.Text.Json;
using MapleLib.WzLib;
using MapleLib.WzLib.Serializer;
using MapleLib.WzLib.WzProperties;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static int Main(string[] args)
    {
        try
        {
            string cwd = Directory.GetCurrentDirectory();
            string mapRoot = args.Length > 0
                ? Path.GetFullPath(args[0], cwd)
                : Path.GetFullPath(Path.Combine(cwd, "MAP"));
            string webRoot = args.Length > 1
                ? Path.GetFullPath(args[1], cwd)
                : Path.GetFullPath(Path.Combine(cwd, "WEB"));
            string outputPath = args.Length > 2
                ? Path.GetFullPath(args[2], cwd)
                : Path.GetFullPath(Path.Combine(cwd, "WEB", "Map", "map-links.json"));

            if (!Directory.Exists(mapRoot))
            {
                Console.Error.WriteLine($"MAP folder not found: {mapRoot}");
                return 1;
            }
            if (!Directory.Exists(webRoot))
            {
                Console.Error.WriteLine($"WEB folder not found: {webRoot}");
                return 1;
            }

            Console.WriteLine($"MAP root:  {mapRoot}");
            Console.WriteLine($"WEB root:  {webRoot}");
            Console.WriteLine($"Output:    {outputPath}");

            var mapLookup = LoadMapLookup(webRoot);
            var mobLookup = LoadEntityLookup(Path.Combine(webRoot, "Mob", "data.json"), normalizeToLength: 7, includeLevelExp: true);
            var npcLookup = LoadEntityLookup(Path.Combine(webRoot, "Npc", "data.json"), normalizeToLength: 7, includeLevelExp: false);

            var output = BuildCrossIndex(mapRoot, mapLookup, mobLookup, npcLookup);

            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            File.WriteAllText(outputPath, JsonSerializer.Serialize(output, JsonOptions));

            Console.WriteLine("Map cross index generated.");
            Console.WriteLine($"- maps parsed: {output.Meta.MapsParsed}/{output.Meta.MapFiles}");
            Console.WriteLine($"- maps with content: {output.Meta.MapsWithContent}");
            Console.WriteLine($"- mob reverse entries: {output.Meta.MobReverseEntries}");
            Console.WriteLine($"- npc reverse entries: {output.Meta.NpcReverseEntries}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 99;
        }
    }

    private static MapCrossOutput BuildCrossIndex(
        string mapRoot,
        Dictionary<string, MapLookupItem> mapLookup,
        Dictionary<string, EntityLookupItem> mobLookup,
        Dictionary<string, EntityLookupItem> npcLookup)
    {
        var mapFiles = Directory.EnumerateFiles(mapRoot, "*.img", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}.svn{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
            .Where(path =>
            {
                string file = Path.GetFileName(path);
                return !file.Equals("AreaCode.img", StringComparison.OrdinalIgnoreCase);
            })
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var maps = new SortedDictionary<string, MapCrossMap>();
        var mobReverse = new Dictionary<string, List<MapCrossMapRef>>();
        var npcReverse = new Dictionary<string, List<MapCrossMapRef>>();

        int parsed = 0;
        int withContent = 0;
        int failed = 0;
        int mobRefs = 0;
        int npcRefs = 0;

        foreach (string mapFile in mapFiles)
        {
            string fileName = Path.GetFileNameWithoutExtension(mapFile);
            if (!IsDigits(fileName))
            {
                continue;
            }

            string mapId = NormalizeId(fileName, 9);
            var lifeInfo = ReadLifeInfo(mapFile);
            if (!lifeInfo.Success)
            {
                failed += 1;
                continue;
            }
            parsed += 1;

            var mobIds = lifeInfo.MobIds.OrderBy(v => v, StringComparer.Ordinal).ToList();
            var npcIds = lifeInfo.NpcIds.OrderBy(v => v, StringComparer.Ordinal).ToList();
            if (mobIds.Count > 0 || npcIds.Count > 0)
            {
                withContent += 1;
            }

            mapLookup.TryGetValue(mapId, out MapLookupItem? mapMeta);

            var mobRows = mobIds.Select(id =>
            {
                mobLookup.TryGetValue(id, out EntityLookupItem? entity);
                return new MapCrossEntity
                {
                    Id = id,
                    Name = entity?.Name,
                    Preview = entity?.Preview,
                    Level = entity?.Level,
                    Exp = entity?.Exp,
                };
            }).ToList();

            var npcRows = npcIds.Select(id =>
            {
                npcLookup.TryGetValue(id, out EntityLookupItem? entity);
                return new MapCrossEntity
                {
                    Id = id,
                    Name = entity?.Name,
                    Preview = entity?.Preview,
                };
            }).ToList();

            var mapRow = new MapCrossMap
            {
                MapId = mapId,
                MapName = mapMeta?.MapName,
                StreetName = mapMeta?.StreetName,
                Tab = mapMeta?.Tab,
                Preview = mapMeta?.Preview,
                MobCount = mobRows.Count,
                NpcCount = npcRows.Count,
                Mobs = mobRows,
                Npcs = npcRows,
            };
            maps[mapId] = mapRow;

            var mapRef = new MapCrossMapRef
            {
                MapId = mapId,
                MapName = mapRow.MapName,
                StreetName = mapRow.StreetName,
                Tab = mapRow.Tab,
                Preview = mapRow.Preview,
                MobCount = mapRow.MobCount,
                NpcCount = mapRow.NpcCount,
            };

            foreach (string mobId in mobIds)
            {
                if (!mobReverse.TryGetValue(mobId, out List<MapCrossMapRef>? list))
                {
                    list = new List<MapCrossMapRef>();
                    mobReverse[mobId] = list;
                }
                list.Add(mapRef);
                mobRefs += 1;
            }

            foreach (string npcId in npcIds)
            {
                if (!npcReverse.TryGetValue(npcId, out List<MapCrossMapRef>? list))
                {
                    list = new List<MapCrossMapRef>();
                    npcReverse[npcId] = list;
                }
                list.Add(mapRef);
                npcRefs += 1;
            }
        }

        var output = new MapCrossOutput
        {
            Meta = new MapCrossMeta
            {
                GeneratedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                MapFiles = mapFiles.Count,
                MapsParsed = parsed,
                MapsWithContent = withContent,
                MapsFailed = failed,
                MobReverseEntries = mobRefs,
                NpcReverseEntries = npcRefs,
            },
            Maps = maps,
            Mobs = new SortedDictionary<string, List<MapCrossMapRef>>(SortMapReverse(mobReverse)),
            Npcs = new SortedDictionary<string, List<MapCrossMapRef>>(SortMapReverse(npcReverse)),
        };

        return output;
    }

    private static Dictionary<string, List<MapCrossMapRef>> SortMapReverse(Dictionary<string, List<MapCrossMapRef>> input)
    {
        var sorted = new Dictionary<string, List<MapCrossMapRef>>();
        foreach (var kv in input.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            var rows = kv.Value
                .OrderBy(row => row.MapId, StringComparer.Ordinal)
                .ToList();
            sorted[kv.Key] = rows;
        }
        return sorted;
    }

    private static LifeReadResult ReadLifeInfo(string imgPath)
    {
        try
        {
            byte[] iv = MapleLib.WzLib.Util.WzTool.GetIvByMapleVersion(WzMapleVersion.BMS);
            var deserializer = new WzImgDeserializer(freeResources: true);
            bool parseOk;
            using WzImage image = deserializer.WzImageFromIMGFile(imgPath, iv, Path.GetFileName(imgPath), out parseOk);
            if (!parseOk)
            {
                return new LifeReadResult(false);
            }

            var mobs = new HashSet<string>(StringComparer.Ordinal);
            var npcs = new HashSet<string>(StringComparer.Ordinal);

            WzImageProperty? lifeProperty = image["life"];
            if (lifeProperty is IPropertyContainer lifeContainer)
            {
                foreach (WzImageProperty node in lifeContainer.WzProperties)
                {
                    if (node is not IPropertyContainer spawnNode)
                    {
                        continue;
                    }

                    string type = ReadPropertyAsString(spawnNode["type"]).Trim().ToLowerInvariant();
                    string idRaw = ReadPropertyAsString(spawnNode["id"]).Trim();
                    if (string.IsNullOrEmpty(type) || string.IsNullOrEmpty(idRaw) || !IsDigits(idRaw))
                    {
                        continue;
                    }

                    string normalized = NormalizeId(idRaw, 7);
                    if (type == "m")
                    {
                        mobs.Add(normalized);
                    }
                    else if (type == "n")
                    {
                        npcs.Add(normalized);
                    }
                }
            }

            return new LifeReadResult(true, mobs, npcs);
        }
        catch
        {
            return new LifeReadResult(false);
        }
    }

    private static Dictionary<string, MapLookupItem> LoadMapLookup(string webRoot)
    {
        var output = new Dictionary<string, MapLookupItem>(StringComparer.Ordinal);
        foreach (string directory in Directory.EnumerateDirectories(webRoot))
        {
            string tab = Path.GetFileName(directory);
            if (!tab.StartsWith("Map", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string dataPath = Path.Combine(directory, "data.json");
            if (!File.Exists(dataPath))
            {
                continue;
            }

            foreach (ExportRow row in LoadRows(dataPath))
            {
                string id = NormalizeId(row.Id, 9);
                if (string.IsNullOrEmpty(id))
                {
                    continue;
                }

                row.Fields ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                row.Fields.TryGetValue("MapName", out string? mapNameField);
                row.Fields.TryGetValue("StreetName", out string? streetNameField);

                var map = new MapLookupItem
                {
                    MapId = id,
                    MapName = FirstNonEmpty(mapNameField, row.Name),
                    StreetName = streetNameField,
                    Tab = FirstNonEmpty(row.Tab, tab),
                    Preview = row.Preview,
                };

                if (!output.ContainsKey(id))
                {
                    output[id] = map;
                }
            }
        }
        return output;
    }

    private static Dictionary<string, EntityLookupItem> LoadEntityLookup(string filePath, int normalizeToLength, bool includeLevelExp)
    {
        var output = new Dictionary<string, EntityLookupItem>(StringComparer.Ordinal);
        if (!File.Exists(filePath))
        {
            return output;
        }

        foreach (ExportRow row in LoadRows(filePath))
        {
            string id = NormalizeId(row.Id, normalizeToLength);
            if (string.IsNullOrEmpty(id))
            {
                continue;
            }

            row.Fields ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            row.Fields.TryGetValue("Name", out string? fieldName);
            row.Fields.TryGetValue("Info", out string? infoRaw);

            int? level = null;
            int? exp = null;
            if (includeLevelExp && !string.IsNullOrWhiteSpace(infoRaw))
            {
                var infoMap = ParseInfoMap(infoRaw);
                if (infoMap.TryGetValue("info.level", out string? levelText))
                {
                    level = ParseIntOrNull(levelText);
                }
                if (infoMap.TryGetValue("info.exp", out string? expText))
                {
                    exp = ParseIntOrNull(expText);
                }
            }

            if (!output.ContainsKey(id))
            {
                output[id] = new EntityLookupItem
                {
                    Id = id,
                    Name = FirstNonEmpty(row.Name, fieldName),
                    Preview = row.Preview,
                    Level = level,
                    Exp = exp,
                };
            }
        }

        return output;
    }

    private static Dictionary<string, string> ParseInfoMap(string infoRaw)
    {
        var output = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string part in infoRaw.Split(','))
        {
            string token = part.Trim();
            if (token.Length == 0)
            {
                continue;
            }
            int eq = token.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }
            string key = token[..eq].Trim();
            string value = token[(eq + 1)..].Trim();
            if (key.Length > 0)
            {
                output[key] = value;
            }
        }
        return output;
    }

    private static List<ExportRow> LoadRows(string filePath)
    {
        string text = File.ReadAllText(filePath).TrimStart('\uFEFF');
        return JsonSerializer.Deserialize<List<ExportRow>>(text, JsonOptions) ?? new List<ExportRow>();
    }

    private static string ReadPropertyAsString(WzImageProperty? prop)
    {
        if (prop == null)
        {
            return string.Empty;
        }

        return prop switch
        {
            WzStringProperty p => p.Value ?? string.Empty,
            WzIntProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
            WzShortProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
            WzLongProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
            WzFloatProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
            WzDoubleProperty p => p.Value.ToString(CultureInfo.InvariantCulture),
            _ => prop.WzValue?.ToString() ?? string.Empty,
        };
    }

    private static string FirstNonEmpty(params string?[] values)
    {
        foreach (string? value in values)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value.Trim();
            }
        }
        return string.Empty;
    }

    private static bool IsDigits(string? value) => !string.IsNullOrEmpty(value) && value.All(char.IsDigit);

    private static string NormalizeId(string? raw, int width)
    {
        string text = raw?.Trim() ?? string.Empty;
        if (text.Length == 0)
        {
            return string.Empty;
        }
        if (!IsDigits(text))
        {
            return text;
        }
        if (text.Length >= width)
        {
            return text;
        }
        return text.PadLeft(width, '0');
    }

    private static int? ParseIntOrNull(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }
        return int.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int value)
            ? value
            : null;
    }

    private sealed class LifeReadResult
    {
        public bool Success { get; }
        public HashSet<string> MobIds { get; }
        public HashSet<string> NpcIds { get; }

        public LifeReadResult(bool success, HashSet<string>? mobIds = null, HashSet<string>? npcIds = null)
        {
            Success = success;
            MobIds = mobIds ?? new HashSet<string>(StringComparer.Ordinal);
            NpcIds = npcIds ?? new HashSet<string>(StringComparer.Ordinal);
        }
    }

    private sealed class ExportRow
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string Tab { get; set; } = string.Empty;
        public string Preview { get; set; } = string.Empty;
        public Dictionary<string, string>? Fields { get; set; }
    }

    private sealed class MapLookupItem
    {
        public string MapId { get; set; } = string.Empty;
        public string? MapName { get; set; }
        public string? StreetName { get; set; }
        public string? Tab { get; set; }
        public string? Preview { get; set; }
    }

    private sealed class EntityLookupItem
    {
        public string Id { get; set; } = string.Empty;
        public string? Name { get; set; }
        public string? Preview { get; set; }
        public int? Level { get; set; }
        public int? Exp { get; set; }
    }

    private sealed class MapCrossOutput
    {
        public MapCrossMeta Meta { get; set; } = new();
        public SortedDictionary<string, MapCrossMap> Maps { get; set; } = new();
        public SortedDictionary<string, List<MapCrossMapRef>> Mobs { get; set; } = new();
        public SortedDictionary<string, List<MapCrossMapRef>> Npcs { get; set; } = new();
    }

    private sealed class MapCrossMeta
    {
        public string GeneratedAt { get; set; } = string.Empty;
        public int MapFiles { get; set; }
        public int MapsParsed { get; set; }
        public int MapsWithContent { get; set; }
        public int MapsFailed { get; set; }
        public int MobReverseEntries { get; set; }
        public int NpcReverseEntries { get; set; }
    }

    private sealed class MapCrossMap
    {
        public string MapId { get; set; } = string.Empty;
        public string? MapName { get; set; }
        public string? StreetName { get; set; }
        public string? Tab { get; set; }
        public string? Preview { get; set; }
        public int MobCount { get; set; }
        public int NpcCount { get; set; }
        public List<MapCrossEntity> Mobs { get; set; } = new();
        public List<MapCrossEntity> Npcs { get; set; } = new();
    }

    private sealed class MapCrossEntity
    {
        public string Id { get; set; } = string.Empty;
        public string? Name { get; set; }
        public string? Preview { get; set; }
        public int? Level { get; set; }
        public int? Exp { get; set; }
    }

    private sealed class MapCrossMapRef
    {
        public string MapId { get; set; } = string.Empty;
        public string? MapName { get; set; }
        public string? StreetName { get; set; }
        public string? Tab { get; set; }
        public string? Preview { get; set; }
        public int MobCount { get; set; }
        public int NpcCount { get; set; }
    }
}
