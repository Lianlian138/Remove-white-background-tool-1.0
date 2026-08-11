/**
 * batch_remove_bg.js
 * 批量立绘去白底 —— 边缘洪水填充 (Flood Fill)
 *
 * 原理：
 *   1. 从图片四个角 / 边缘采样背景颜色
 *   2. 从边缘像素出发做 BFS 洪水填充
 *   3. 只有"与边缘相连且颜色接近背景色"的像素才被标记为透明
 *   4. 白色连衣裙等封闭区域内的高亮像素不受影响（不与边缘连通）
 *
 * 用法：
 *   npm install sharp
 *   node batch_remove_bg.js
 *
 * 输入：  Image/*.jpg, Image/*.png（自动跳过背景图 b*.png / CG*.jpg）
 * 输出：  Image/processed/*.png（保留 Alpha 通道）
 */

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

// ======================== 配置 ========================
const INPUT_DIR   = path.join(__dirname, 'Image');
const OUTPUT_DIR  = path.join(__dirname, 'Image', 'processed');
const TOLERANCE   = 45;   // 颜色容差 (0-255)，越大越激进
const CORNER_SIZE = 5;    // 四角采样区域大小 (px)

// 跳过背景图 & CG 图（只处理立绘表情文件）
const SKIP_PATTERNS = [
  /^b\d+\.png$/i,        // b1.png ~ b19.png 背景
  /^CG\d+\.(jpg|png)$/i, // CG 全屏图
  /^processed$/i,        // 输出目录自身
];

// ======================== 工具函数 ========================

/** 计算两个 RGB 颜色的切比雪夫距离 */
function colorDist(r1, g1, b1, r2, g2, b2) {
  return Math.max(
    Math.abs(r1 - r2),
    Math.abs(g1 - g2),
    Math.abs(b1 - b2)
  );
}

/**
 * 四角采样：取图片四个角 CORNER_SIZE×CORNER_SIZE 区域内所有像素的中位数颜色
 * 返回 { r, g, b } 背景参考色
 */
function sampleBackground(pixels, width, height) {
  const samples = [];
  const corners = [
    [0, 0],                                    // 左上
    [width - CORNER_SIZE, 0],                  // 右上
    [0, height - CORNER_SIZE],                 // 左下
    [width - CORNER_SIZE, height - CORNER_SIZE] // 右下
  ];

  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + CORNER_SIZE && y < height; y++) {
      for (let x = cx; x < cx + CORNER_SIZE && x < width; x++) {
        const idx = (y * width + x) * 4;
        samples.push({
          r: pixels[idx],
          g: pixels[idx + 1],
          b: pixels[idx + 2]
        });
      }
    }
  }

  // 按亮度排序，取中位数（抗噪）
  samples.sort((a, b) =>
    (0.299 * a.r + 0.587 * a.g + 0.114 * a.b) -
    (0.299 * b.r + 0.587 * b.g + 0.114 * b.b)
  );
  const mid = samples[Math.floor(samples.length / 2)];
  return mid;
}

/**
 * 洪水填充 (BFS)：从所有与背景色匹配的边缘像素出发，标记连通区域
 * @returns {Uint8Array} mask — 1 = 背景（需透明化），0 = 前景（保留）
 */
function floodFill(pixels, width, height, bgColor, tolerance) {
  const totalPixels = width * height;
  const mask   = new Uint8Array(totalPixels);  // 0=未访问, 1=背景
  const visited = new Uint8Array(totalPixels);  // BFS visited
  const queue  = [];

  // 辅助：获取像素索引
  function idx(x, y) { return y * width + x; }

  // 辅助：判断像素是否匹配背景色
  function isBg(x, y) {
    const i = (y * width + x) * 4;
    return colorDist(pixels[i], pixels[i + 1], pixels[i + 2], bgColor.r, bgColor.g, bgColor.b) <= tolerance;
  }

  // 初始化队列：所有边缘像素中匹配背景色的
  // 上边 + 下边
  for (let x = 0; x < width; x++) {
    if (isBg(x, 0))           { const k = idx(x, 0);           if (!visited[k]) { visited[k] = 1; queue.push([x, 0]); } }
    if (isBg(x, height - 1))  { const k = idx(x, height - 1);  if (!visited[k]) { visited[k] = 1; queue.push([x, height - 1]); } }
  }
  // 左边 + 右边
  for (let y = 1; y < height - 1; y++) {
    if (isBg(0, y))          { const k = idx(0, y);          if (!visited[k]) { visited[k] = 1; queue.push([0, y]); } }
    if (isBg(width - 1, y))  { const k = idx(width - 1, y);  if (!visited[k]) { visited[k] = 1; queue.push([width - 1, y]); } }
  }

  // BFS 4-directional
  const DIRS = [[0,1],[0,-1],[1,0],[-1,0]];
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    mask[idx(cx, cy)] = 1;

    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nk = idx(nx, ny);
      if (visited[nk]) continue;
      visited[nk] = 1;
      if (isBg(nx, ny)) {
        queue.push([nx, ny]);
      }
    }
  }

  return mask;
}

/**
 * 处理单张图片
 */
async function processImage(inputPath, outputPath, filename) {
  console.log(`  → 处理: ${filename}`);

  // 读取为原始 RGBA 像素
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()       // 确保有 Alpha 通道
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const pixels = new Uint8Array(data); // RGBA 原始数据

  // 1. 采样背景色
  const bgColor = sampleBackground(pixels, width, height);
  console.log(`    背景色: RGB(${bgColor.r}, ${bgColor.g}, ${bgColor.b})`);

  // 2. 洪水填充标记背景区域
  const mask = floodFill(pixels, width, height, bgColor, TOLERANCE);
  const bgPixels = mask.reduce((sum, v) => sum + v, 0);
  const bgPercent = ((bgPixels / (width * height)) * 100).toFixed(1);
  console.log(`    背景像素: ${bgPixels} (${bgPercent}%)`);

  // 3. 应用 mask → 将背景像素的 Alpha 设为 0
  for (let i = 0; i < width * height; i++) {
    if (mask[i] === 1) {
      pixels[i * 4 + 3] = 0; // Alpha = 0
    }
  }

  // 4. 写回 PNG
  await sharp(pixels, {
    raw: {
      width,
      height,
      channels: 4
    }
  })
    .png({ compressionLevel: 9, palette: true, quality: 100 })
    .toFile(outputPath);

  console.log(`    ✓ 已保存: ${path.basename(outputPath)}`);
}

/**
 * 主流程
 */
async function main() {
  console.log('══════════════════════════════════════');
  console.log('  立绘批量去白底 (Flood Fill)');
  console.log(`  容差: ${TOLERANCE}  |  角采样: ${CORNER_SIZE}×${CORNER_SIZE}px`);
  console.log('══════════════════════════════════════\n');

  // 检查输入目录
  if (!fs.existsSync(INPUT_DIR)) {
    console.error(`❌ 输入目录不存在: ${INPUT_DIR}`);
    process.exit(1);
  }

  // 创建输出目录
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`📁 创建输出目录: ${OUTPUT_DIR}\n`);
  }

  // 扫描图片文件
  const files = fs.readdirSync(INPUT_DIR)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .filter(f => !SKIP_PATTERNS.some(p => p.test(f)))
    .filter(f => {
      // 排除纯背景图（按文件名启发式判断：以 b 开头 + 数字）
      return true; // SKIP_PATTERNS 已处理
    })
    .sort();

  if (files.length === 0) {
    console.log('⚠ 没有找到需要处理的立绘文件。');
    console.log('   (背景图 b*.png 和 CG 图已被自动跳过)');
    return;
  }

  console.log(`📋 找到 ${files.length} 个立绘文件:\n`);
  files.forEach(f => console.log(`    - ${f}`));
  console.log('');

  let successCount = 0;
  let failCount = 0;

  for (const filename of files) {
    try {
      await processImage(
        path.join(INPUT_DIR, filename),
        path.join(OUTPUT_DIR, filename.replace(/\.\w+$/, '.png')),
        filename
      );
      successCount++;
    } catch (err) {
      console.error(`    ❌ 失败: ${err.message}`);
      failCount++;
    }
  }

  console.log('\n══════════════════════════════════════');
  console.log(`  完成: ${successCount} 成功, ${failCount} 失败`);
  console.log(`  输出: ${OUTPUT_DIR}`);
  console.log('══════════════════════════════════════');
}

main().catch(err => {
  console.error('致命错误:', err);
  process.exit(1);
});
