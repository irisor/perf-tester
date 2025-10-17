module.exports = (req, res) => {
    console.log('Health check called!');
    
    try {
        const puppeteer = require('puppeteer-core');
        const chromium = require('@sparticuz/chromium');
        
        return res.json({ 
            status: 'ok',
            dependencies: 'loaded',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Dependency error:', error);
        return res.status(500).json({ 
            status: 'error',
            error: error.message 
        });
    }
};
