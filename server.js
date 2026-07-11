require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ========== MULTER CONFIGURATION ==========
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads', req.body.folder || 'default');
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    },
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// ========== TELEGRAM BOT SETUP ==========
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

async function sendTelegramMessage(message, imageBuffer = null, options = {}) {
    try {
        if (imageBuffer) {
            await bot.sendPhoto(TELEGRAM_CHAT_ID, imageBuffer, { caption: message, ...options });
        } else {
            await bot.sendMessage(TELEGRAM_CHAT_ID, message, options);
        }
    } catch (error) {
        console.error('Telegram error:', error.message);
    }
}

async function sendTelegramDocument(filePath, caption = '') {
    try {
        const fileStream = await fs.readFile(filePath);
        await bot.sendDocument(TELEGRAM_CHAT_ID, fileStream, { caption });
    } catch (error) {
        console.error('Document send error:', error.message);
    }
}

// ========== IMAGE PROCESSING SERVICE ==========
class ImageProcessor {
    static async processImage(imagePath) {
        try {
            const metadata = await sharp(imagePath).metadata();
            const thumbnail = await sharp(imagePath)
                .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
                .png()
                .toBuffer();
            
            return {
                width: metadata.width,
                height: metadata.height,
                format: metadata.format,
                space: metadata.space,
                thumbnail: thumbnail.toString('base64')
            };
        } catch (error) {
            throw new Error(`Image processing failed: ${error.message}`);
        }
    }

    static async generateNestingPreview(nestingData) {
        try {
            const { items, rollWidth, rollHeight } = nestingData;
            const scale = 2;
            
            const svg = this.generateNestingSVG(items, rollWidth, rollHeight, scale);
            const buffer = await sharp(Buffer.from(svg))
                .png()
                .toBuffer();
            
            return buffer;
        } catch (error) {
            console.error('Nesting preview generation failed:', error);
            throw error;
        }
    }

    static generateNestingSVG(items, rollWidth, rollHeight, scale) {
        const svgWidth = rollWidth * scale;
        const svgHeight = rollHeight * scale;
        
        let svg = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">`;
        svg += `<rect width="${svgWidth}" height="${svgHeight}" fill="white" stroke="black" stroke-width="2"/>`;
        
        items.forEach((item, idx) => {
            const x = item.x * scale;
            const y = item.y * scale;
            const w = item.width * scale;
            const h = item.height * scale;
            
            const colors = ['#d4af37', '#2563eb', '#10b981', '#f59e0b', '#ec4899'];
            const color = colors[idx % colors.length];
            
            svg += `
                <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5,5"/>
                <text x="${x + 10}" y="${y + 30}" font-size="12" fill="#000">${item.name}</text>
                <text x="${x + 10}" y="${y + 50}" font-size="10" fill="#666">${item.width}×${item.height}cm</text>
            `;
        });
        
        svg += `</svg>`;
        return svg;
    }
}

// ========== NESTING ALGORITHM ==========
class NestingEngine {
    static calculateNesting(items, rollWidth, rollHeight, config = {}) {
        const { gap = 0, allowRotation = true } = config;
        
        let processedItems = [];
        items.forEach(item => {
            for (let i = 0; i < item.quantity; i++) {
                processedItems.push({
                    ...item,
                    id: `${item.id}-${i}`,
                    width: item.width,
                    height: item.height,
                    rotation: 0
                });
            }
        });
        
        // Sort by area descending (First Fit Decreasing)
        processedItems.sort((a, b) => (b.width * b.height) - (a.width * a.height));
        
        const result = {
            items: [],
            totalArea: 0,
            totalLength: 0,
            efficiency: 0,
            rollsNeeded: 0
        };
        
        let currentY = 0;
        let rowItems = [];
        let rowHeight = 0;
        
        processedItems.forEach(item => {
            let itemWidth = item.width;
            let itemHeight = item.height;
            let canFit = false;
            
            // Try normal orientation
            if (this.canFitInRow(rowItems, itemWidth, itemHeight, rollWidth, gap)) {
                canFit = true;
            }
            
            // Try rotated orientation
            if (!canFit && allowRotation && itemHeight < rollWidth && itemWidth > rollWidth) {
                [itemWidth, itemHeight] = [itemHeight, itemWidth];
                item.rotation = 90;
                if (this.canFitInRow(rowItems, itemWidth, itemHeight, rollWidth, gap)) {
                    canFit = true;
                }
            }
            
            // Move to new row if item doesn't fit
            if (!canFit && rowItems.length > 0) {
                currentY += rowHeight + gap;
                rowItems = [];
                rowHeight = 0;
            }
            
            // Calculate position
            let xPos = rowItems.reduce((sum, i) => sum + i.width + gap, 0);
            
            result.items.push({
                ...item,
                width: itemWidth,
                height: itemHeight,
                x: xPos,
                y: currentY
            });
            
            rowItems.push({ width: itemWidth, height: itemHeight });
            rowHeight = Math.max(rowHeight, itemHeight);
        });
        
        // Final calculations
        result.totalLength = currentY + rowHeight;
        result.totalArea = (rollWidth * result.totalLength) / 10000; // Convert to m²
        const usedArea = result.items.reduce((sum, item) => sum + (item.width * item.height), 0) / 10000;
        result.efficiency = ((usedArea / result.totalArea) * 100).toFixed(2);
        result.rollsNeeded = Math.ceil(result.totalLength / 100);
        
        return result;
    }
    
    static canFitInRow(rowItems, width, height, rollWidth, gap) {
        const currentRowWidth = rowItems.reduce((sum, item) => sum + item.width + gap, 0);
        return (currentRowWidth + width) <= rollWidth;
    }
}

// ========== API ENDPOINTS ==========

// Get all files/projects
app.get('/api/files', async (req, res) => {
    try {
        const uploadsDir = path.join(__dirname, 'uploads');
        await fs.mkdir(uploadsDir, { recursive: true });
        
        const folders = await fs.readdir(uploadsDir);
        const files = [];
        
        for (const folder of folders) {
            const folderPath = path.join(uploadsDir, folder);
            const stats = await fs.stat(folderPath);
            
            if (stats.isDirectory()) {
                const folderFiles = await fs.readdir(folderPath);
                
                for (const file of folderFiles) {
                    const filePath = path.join(folderPath, file);
                    try {
                        const imageData = await ImageProcessor.processImage(filePath);
                        files.push({
                            id: `${folder}-${file}`,
                            name: file,
                            folder: folder,
                            path: `/uploads/${folder}/${file}`,
                            size: imageData,
                            timestamp: (await fs.stat(filePath)).mtime
                        });
                    } catch (error) {
                        console.error(`Failed to process ${file}:`, error.message);
                    }
                }
            }
        }
        
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload single/multiple files
app.post('/api/upload', upload.array('files', 50), async (req, res) => {
    try {
        const { folder = 'default' } = req.body;
        const uploadedFiles = [];
        
        for (const file of req.files) {
            try {
                const imageData = await ImageProcessor.processImage(file.path);
                uploadedFiles.push({
                    id: `${folder}-${file.filename}`,
                    name: file.originalname,
                    filename: file.filename,
                    folder: folder,
                    path: `/uploads/${folder}/${file.filename}`,
                    size: imageData
                });
            } catch (error) {
                console.error(`Failed to process ${file.originalname}:`, error.message);
            }
        }
        
        // Send notification to Telegram
        await sendTelegramMessage(
            `📤 New Files Uploaded\n\n${uploadedFiles.map(f => `• ${f.name}`).join('\n')}\n\nFolder: ${folder}`
        );
        
        res.json({ success: true, files: uploadedFiles });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Generate nesting layout
app.post('/api/nesting/generate', async (req, res) => {
    try {
        const { items, rollWidth, rollHeight, config } = req.body;
        
        if (!items || !rollWidth) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
        const nestingResult = NestingEngine.calculateNesting(
            items,
            rollWidth,
            rollHeight || 500,
            config
        );
        
        // Generate preview
        const preview = await ImageProcessor.generateNestingPreview({
            items: nestingResult.items,
            rollWidth,
            rollHeight: nestingResult.totalLength
        });
        
        // Send to Telegram
        const message = `
📊 NESTING LAYOUT GENERATED
━━━━━━━━━━━━━━━━━━━━━━
Items: ${nestingResult.items.length}
Total Area: ${nestingResult.totalArea} m²
Efficiency: ${nestingResult.efficiency}%
Rolls Needed: ${nestingResult.rollsNeeded}
Length: ${nestingResult.totalLength}cm
        `;
        
        await sendTelegramMessage(message, preview);
        
        res.json(nestingResult);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get nesting details
app.get('/api/nesting/:id', async (req, res) => {
    try {
        // This would retrieve a saved nesting from database
        res.json({ message: 'Nesting details endpoint' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Export nesting as PDF/SVG/PNG
app.post('/api/nesting/export', async (req, res) => {
    try {
        const { nestingData, format = 'pdf' } = req.body;
        
        if (format === 'svg') {
            const svg = ImageProcessor.generateNestingSVG(
                nestingData.items,
                nestingData.rollWidth,
                nestingData.totalLength,
                1
            );
            res.header('Content-Type', 'image/svg+xml');
            res.send(svg);
        } else if (format === 'png') {
            const preview = await ImageProcessor.generateNestingPreview(nestingData);
            res.header('Content-Type', 'image/png');
            res.send(preview);
        } else {
            res.status(400).json({ error: 'Unsupported format' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete file
app.delete('/api/files/:folder/:filename', async (req, res) => {
    try {
        const { folder, filename } = req.params;
        const filePath = path.join(__dirname, 'uploads', folder, filename);
        
        await fs.unlink(filePath);
        
        await sendTelegramMessage(`🗑️ File Deleted: ${filename}\nFolder: ${folder}`);
        
        res.json({ success: true, message: 'File deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Batch operations
app.post('/api/batch/process', async (req, res) => {
    try {
        const { action, files } = req.body;
        const results = [];
        
        if (action === 'move') {
            const { sourceFolder, destinationFolder } = req.body;
            for (const file of files) {
                const sourcePath = path.join(__dirname, 'uploads', sourceFolder, file);
                const destPath = path.join(__dirname, 'uploads', destinationFolder, file);
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                await fs.rename(sourcePath, destPath);
                results.push({ file, status: 'moved' });
            }
        }
        
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'online', timestamp: new Date().toISOString() });
});

// ========== ERROR HANDLING ==========
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
});

// ========== SERVER START ==========
app.listen(PORT, () => {
    console.log(`🚀 Nesting Server running on port ${PORT}`);
    console.log(`📁 Uploads directory: ${path.join(__dirname, 'uploads')}`);
    if (TELEGRAM_TOKEN) {
        console.log(`📱 Telegram integration: Active`);
    }
});

module.exports = app;
