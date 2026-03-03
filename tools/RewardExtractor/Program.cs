using MapleLib.WzLib;
using MapleLib.WzLib.Serializer;
using MapleLib.WzLib.WzProperties;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            string cwd = Directory.GetCurrentDirectory();
            string inputPath = args.Length > 0
                ? Path.GetFullPath(args[0], cwd)
                : Path.GetFullPath(Path.Combine(cwd, "REWARD", "Reward.img"));
            string outputPath = args.Length > 1
                ? Path.GetFullPath(args[1], cwd)
                : Path.GetFullPath(Path.Combine(cwd, "REWARD", "Reward.export.json"));

            if (!File.Exists(inputPath))
            {
                Console.Error.WriteLine($"Input file not found: {inputPath}");
                return 1;
            }

            Console.WriteLine($"Input:  {inputPath}");
            Console.WriteLine($"Output: {outputPath}");

            var probeOrder = new[]
            {
                WzMapleVersion.BMS,
                WzMapleVersion.CLASSIC,
                WzMapleVersion.GMS,
                WzMapleVersion.EMS,
                WzMapleVersion.CUSTOM,
            };

            WzImage? bestImage = null;
            WzMapleVersion bestVersion = WzMapleVersion.UNKNOWN;
            double bestScore = double.MinValue;

            foreach (var version in probeOrder)
            {
                var (image, score, details) = TryReadImage(inputPath, version);
                if (image == null)
                {
                    Console.WriteLine($"[{version}] failed");
                    continue;
                }

                Console.WriteLine($"[{version}] parsed | score={score:F2} | {details}");
                if (score > bestScore)
                {
                    bestImage?.Dispose();
                    bestImage = image;
                    bestVersion = version;
                    bestScore = score;
                }
                else
                {
                    image.Dispose();
                }
            }

            if (bestImage == null)
            {
                Console.Error.WriteLine("Failed to parse Reward.img with known Maple versions.");
                return 2;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);

            var serializer = new WzJsonBsonSerializer(
                indentation: 2,
                lineBreakType: LineBreak.Windows,
                bExportBase64Data: false,
                bExportAsJson: true);

            serializer.SerializeImage(bestImage, outputPath);
            Console.WriteLine($"Chosen version: {bestVersion}");
            Console.WriteLine($"Exported JSON:  {outputPath}");
            Console.WriteLine($"Top-level nodes: {bestImage.WzProperties.Count}");

            string summaryPath = Path.Combine(
                Path.GetDirectoryName(outputPath)!,
                Path.GetFileNameWithoutExtension(outputPath) + ".summary.txt");
            WriteSimpleSummary(bestImage, summaryPath);
            Console.WriteLine($"Summary:        {summaryPath}");

            bestImage.Dispose();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 99;
        }
    }

    private static (WzImage? image, double score, string details) TryReadImage(string path, WzMapleVersion version)
    {
        try
        {
            byte[] iv = MapleLib.WzLib.Util.WzTool.GetIvByMapleVersion(version);
            var deserializer = new WzImgDeserializer(freeResources: true);
            bool parseOk;
            WzImage image = deserializer.WzImageFromIMGFile(path, iv, Path.GetFileName(path), out parseOk);
            if (!parseOk)
            {
                image.Dispose();
                return (null, double.MinValue, "parse=false");
            }

            int topCount = image.WzProperties.Count;
            if (topCount <= 0)
            {
                image.Dispose();
                return (null, double.MinValue, "empty");
            }

            int readable = 0;
            int sampleInspect = 0;
            int hintMatches = 0;
            foreach (var prop in image.WzProperties)
            {
                if (IsReadableName(prop.Name))
                {
                    readable += 1;
                }

                if (sampleInspect < 30)
                {
                    sampleInspect += 1;
                    hintMatches += CountHintMatches(prop);
                }
            }

            double ratio = (double)readable / topCount;
            double score = (topCount * 2.0) + (ratio * 200.0) + (hintMatches * 8.0);
            string details = $"top={topCount}, readable={readable}, hints={hintMatches}";
            return (image, score, details);
        }
        catch (Exception ex)
        {
            return (null, double.MinValue, ex.Message);
        }
    }

    private static bool IsReadableName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }
        foreach (char c in name)
        {
            if (char.IsLetterOrDigit(c) || c == '_' || c == '-' || c == '.' || c == '/' || c == ':')
            {
                continue;
            }
            return false;
        }
        return true;
    }

    private static int CountHintMatches(WzImageProperty prop)
    {
        int points = 0;
        string n = (prop.Name ?? string.Empty).ToLowerInvariant();
        if (n.Contains("item") || n.Contains("reward") || n.Contains("money") || n.Contains("meso") || n.Contains("exp"))
        {
            points += 1;
        }

        if (prop is IPropertyContainer container)
        {
            foreach (var sub in container.WzProperties)
            {
                string sn = (sub.Name ?? string.Empty).ToLowerInvariant();
                if (sn.Contains("item") || sn.Contains("reward") || sn.Contains("money") || sn.Contains("meso") || sn.Contains("exp"))
                {
                    points += 1;
                }
            }
        }

        return points;
    }

    private static void WriteSimpleSummary(WzImage image, string path)
    {
        using var writer = new StreamWriter(path, false);
        writer.WriteLine("Reward.img quick summary");
        writer.WriteLine($"Top-level nodes: {image.WzProperties.Count}");
        writer.WriteLine();
        writer.WriteLine("First 60 top-level node names:");

        int index = 0;
        foreach (var prop in image.WzProperties)
        {
            writer.WriteLine($"- {prop.Name}");
            index += 1;
            if (index >= 60)
            {
                break;
            }
        }
    }
}
