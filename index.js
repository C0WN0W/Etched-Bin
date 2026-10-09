const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
let mm = null;

async function initMusicMetadata() {
    try {
        mm = await import('music-metadata');
    } catch (err) {
        console.log('Failed to load music-metadata:', err.message);
        mm = null;
    }
}

const app = express();
const PORT = 2999;

const BIN_DIR = path.join(__dirname, 'bin');
const COVER_DIR = path.join(__dirname, 'covers');
const RES_DIR = path.join(__dirname, 'res');

if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
}

if (!fs.existsSync(COVER_DIR)) {
    fs.mkdirSync(COVER_DIR, { recursive: true });
}

function fixFilenameEncoding(filename) {
    try {
        return Buffer.from(filename, 'latin1').toString('utf8');
    } catch (e) {
        return filename;
    }
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, BIN_DIR);
    },
    filename: (req, file, cb) => {
        const originalName = fixFilenameEncoding(file.originalname);
        const fileName = originalName.replace(/[\\/:*?"<>|]/g, '_');
        
        if (fs.existsSync(path.join(BIN_DIR, fileName))) {
            return cb(new Error('已存在同名文件'));
        }
        
        cb(null, fileName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const mimeType = file.mimetype.toLowerCase();
        
        if (ext === '.mp3' && (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3')) {
            cb(null, true);
        } else {
            cb(new Error('仅支持 MP3 文件'));
        }
    }
});

app.use(express.json());
app.use('/bin', express.static(BIN_DIR));
app.use('/covers', express.static(COVER_DIR));
app.use('/res', express.static(RES_DIR));

async function extractCover(filePath, coverName) {
    if (!mm) return null;
    try {
        const metadata = await mm.parseFile(filePath);
        if (metadata.common.picture && metadata.common.picture.length > 0) {
            const picture = metadata.common.picture[0];
            const coverExt = picture.format === 'image/jpeg' ? '.jpg' : 
                           picture.format === 'image/png' ? '.png' : '.jpg';
            const coverPath = path.join(COVER_DIR, coverName + coverExt);
            fs.writeFileSync(coverPath, picture.data);
            return `/covers/${coverName + coverExt}`;
        }
    } catch (err) {
        console.log('Error extracting cover:', err.message);
    }
    return null;
}

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '未选择文件' });
    }
    
    const originalName = req.file.originalname.replace(/\.[^/.]+$/, '');
    const coverName = path.basename(req.file.filename, '.mp3');
    const coverUrl = await extractCover(req.file.path, coverName);
    
    const finalCoverUrl = coverUrl || '/res/default_album_cover.png';
    
    res.json({
        success: true,
        filename: req.file.filename,
        originalName: originalName,
        url: `/bin/${encodeURIComponent(req.file.filename)}`,
        coverUrl: coverUrl ? `/covers/${encodeURIComponent(coverName + path.extname(coverUrl))}` : finalCoverUrl,
        hasCustomCover: !!coverUrl
    });
});

app.get('/files', async (req, res) => {
    fs.readdir(BIN_DIR, async (err, files) => {
        if (err) {
            return res.status(500).json({ error: '读取文件列表失败' });
        }
        
        const mp3Files = files
            .filter(file => path.extname(file).toLowerCase() === '.mp3')
            .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        
        const fileList = [];
        
        for (const file of mp3Files) {
            const originalName = file.replace(/\.[^/.]+$/, '');
            const coverName = path.basename(file, '.mp3');
            let coverUrl = null;
            
            const coverJpg = path.join(COVER_DIR, coverName + '.jpg');
            const coverPng = path.join(COVER_DIR, coverName + '.png');
            
            if (fs.existsSync(coverJpg)) {
                coverUrl = `/covers/${encodeURIComponent(coverName + '.jpg')}`;
            } else if (fs.existsSync(coverPng)) {
                coverUrl = `/covers/${encodeURIComponent(coverName + '.png')}`;
            } else {
                coverUrl = '/res/default_album_cover.png';
            }
            
            fileList.push({
                name: file,
                originalName: originalName,
                url: `/bin/${encodeURIComponent(file)}`,
                coverUrl: coverUrl,
                hasCustomCover: fs.existsSync(coverJpg) || fs.existsSync(coverPng)
            });
        }
        
        res.json({ files: fileList });
    });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), {
        root: __dirname
    });
});

app.delete('/delete/:filename', (req, res) => {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(BIN_DIR, filename);
    const coverName = path.basename(filename, '.mp3');
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
    }
    
    try {
        fs.unlinkSync(filePath);
        
        const coverJpg = path.join(COVER_DIR, coverName + '.jpg');
        const coverPng = path.join(COVER_DIR, coverName + '.png');
        
        if (fs.existsSync(coverJpg)) {
            fs.unlinkSync(coverJpg);
        }
        if (fs.existsSync(coverPng)) {
            fs.unlinkSync(coverPng);
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除文件失败' });
    }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: '文件大小超过 10MB 限制' });
        }
        return res.status(400).json({ error: '上传错误' });
    }
    res.status(400).json({ error: err.message || '服务器错误' });
});

initMusicMetadata().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
});