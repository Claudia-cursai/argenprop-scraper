const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Argenprop Scraper', timestamp: new Date().toISOString() });
});

// Endpoint principal de scraping
app.post('/scrape/argenprop', async (req, res) => {
  console.log('🎭 Iniciando scraping de Argenprop...');
  
  const { 
    limit = 10, 
    zona = 'capital-federal',
    tipo = '1-dormitorio'
  } = req.body;
  
  let browser;
  
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--memory-pressure-off',
        '--single-process',
        '--no-zygote'
      ]
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'es-AR'
    });
    
    const page = await context.newPage();
    
    const url = `https://www.argenprop.com/propiedades/venta/${zona}/${tipo}/orden-masnuevas`;
    console.log(`🔍 Accediendo a: ${url}`);
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('article[data-qa="posting PROPERTY"]', { timeout: 30000 });
    
    const properties = await page.evaluate((maxProperties) => {
      const articles = Array.from(document.querySelectorAll('article[data-qa="posting PROPERTY"]')).slice(0, maxProperties);
      
      return articles.map(article => {
        const link = article.querySelector('a[href*="/propiedades/"]')?.href;
        const titulo = article.querySelector('h2')?.textContent?.trim() || 'Sin título';
        const precio = article.querySelector('[data-qa="POSTING_CARD_PRICE"]')?.textContent?.trim() || 'Consultar';
        const ubicacion = article.querySelector('[data-qa="POSTING_CARD_LOCATION"]')?.textContent?.trim() || 'Sin ubicación';
        
        return {
          link,
          titulo,
          precio,
          ubicacion,
          id_unico: link ? link.split('/').pop() : Math.random().toString(36)
        };
      }).filter(p => p.link);
    }, limit);
    
    console.log(`🏠 Encontradas ${properties.length} propiedades`);
    
    const results = [];
    
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      console.log(`📋 ${i + 1}/${properties.length}: ${property.titulo.substring(0, 40)}...`);
      
      try {
        await page.goto(property.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        
        const contactData = await page.evaluate(() => {
          let telefono = null;
          let nombre = 'No especificado';
          
          const phoneSelectors = [
            '[data-qa*="phone"]',
            '[data-qa*="contact"]',
            '[href^="tel:"]',
            '[href*="wa.me"]'
          ];
          
          for (const selector of phoneSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              const text = el.textContent || el.href || '';
              const phoneMatch = text.match(/(\+54\s*9?\s*)?(\(?1[15]\)?\s*)?(\d{4}[\s-]?\d{4})/);
              if (phoneMatch) {
                telefono = phoneMatch[0];
                break;
              }
            }
            if (telefono) break;
          }
          
          if (!telefono) {
            const html = document.body.innerHTML;
            const patterns = [
              /\+54\s*9?\s*11\s*\d{4}[\s-]?\d{4}/g,
              /\(?11\)?\s*\d{4}[\s-]?\d{4}/g,
              /15\s*\d{4}[\s-]?\d{4}/g
            ];
            
            for (const pattern of patterns) {
              const match = html.match(pattern);
              if (match) {
                telefono = match[0];
                break;
              }
            }
          }
          
          return { telefono, nombre };
        });
        
        let telefonoNormalizado = null;
        if (contactData.telefono) {
          const telLimpio = contactData.telefono.replace(/\D/g, '');
          if (telLimpio.startsWith('54')) {
            telefonoNormalizado = '+' + telLimpio;
          } else if (telLimpio.startsWith('11') && telLimpio.length === 10) {
            telefonoNormalizado = '+549' + telLimpio;
          } else if (telLimpio.length === 8) {
            telefonoNormalizado = '+54911' + telLimpio;
          }
        }
        
        const resultado = {
          ...property,
          telefono: telefonoNormalizado,
          nombre: contactData.nombre,
          fuente: 'Argenprop',
          fecha_scraping: new Date().toISOString(),
          tiene_telefono: !!telefonoNormalizado,
          estado_extraccion: telefonoNormalizado ? 'EXITOSO' : 'SIN_TELEFONO'
        };
        
        results.push(resultado);
        console.log(`${telefonoNormalizado ? '✅' : '❌'} ${telefonoNormalizado || 'Sin teléfono'}`);
        
      } catch (error) {
        console.log(`❌ Error: ${error.message}`);
      }
      
      await page.waitForTimeout(1000);
    }
    
    const stats = {
      total: results.length,
      con_telefono: results.filter(r => r.tiene_telefono).length,
      tasa_exito: Math.round((results.filter(r => r.tiene_telefono).length / results.length) * 100)
    };
    
    console.log(`🎯 Completado: ${stats.con_telefono}/${stats.total} (${stats.tasa_exito}%)`);
    
    res.json({
      success: true,
      data: results,
      stats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error general:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Scraper API corriendo en puerto ${PORT}`);
});
