const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Argenprop Scraper - Solo Dueños', timestamp: new Date().toISOString() });
});

// Endpoint principal de scraping - SOLO DUEÑOS DIRECTOS
app.post('/scrape/argenprop', async (req, res) => {
  console.log('🎭 Iniciando scraping de Argenprop - SOLO DUEÑOS DIRECTOS...');
  
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
    
    // URL MODIFICADA - Solo dueños directos
    const url = `https://www.argenprop.com/propiedades/venta/${zona}/${tipo}/tipo-publicador-dueno/orden-masnuevas`;
    console.log(`🏠 Accediendo a SOLO DUEÑOS: ${url}`);
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Esperar y verificar que hay propiedades
    try {
      await page.waitForSelector('article[data-qa="posting PROPERTY"]', { timeout: 15000 });
    } catch (error) {
      // Si no encuentra propiedades con filtro de dueño, intentar URL alternativa
      console.log('⚠️ No hay propiedades con filtro dueño, probando URL alternativa...');
      const urlAlternativa = `https://www.argenprop.com/propiedades/venta/${zona}/${tipo}/orden-masnuevas`;
      await page.goto(urlAlternativa, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('article[data-qa="posting PROPERTY"]', { timeout: 30000 });
    }
    
    const properties = await page.evaluate((maxProperties) => {
      const articles = Array.from(document.querySelectorAll('article[data-qa="posting PROPERTY"]')).slice(0, maxProperties);
      
      return articles.map(article => {
        const link = article.querySelector('a[href*="/propiedades/"]')?.href;
        const titulo = article.querySelector('h2')?.textContent?.trim() || 'Sin título';
        const precio = article.querySelector('[data-qa="POSTING_CARD_PRICE"]')?.textContent?.trim() || 'Consultar';
        const ubicacion = article.querySelector('[data-qa="POSTING_CARD_LOCATION"]')?.textContent?.trim() || 'Sin ubicación';
        
        // Buscar indicadores de que es dueño directo
        const esDueno = article.textContent.toLowerCase().includes('dueño') || 
                       article.textContent.toLowerCase().includes('propietario') ||
                       !article.textContent.toLowerCase().includes('inmobiliaria');
        
        return {
          link,
          titulo,
          precio,
          ubicacion,
          es_dueno_directo: esDueno,
          id_unico: link ? link.split('/').pop() : Math.random().toString(36)
        };
      }).filter(p => p.link);
    }, limit * 2); // Buscar más para filtrar después
    
    console.log(`🏠 Encontradas ${properties.length} propiedades, filtrando dueños...`);
    
    // Filtrar solo las que parecen ser de dueños directos
    const propiedadesDuenos = properties.filter(p => p.es_dueno_directo).slice(0, limit);
    
    console.log(`👤 Propiedades de dueños: ${propiedadesDuenos.length}/${properties.length}`);
    
    const results = [];
    
    // Procesar cada propiedad de dueño
    for (let i = 0; i < propiedadesDuenos.length; i++) {
      const property = propiedadesDuenos[i];
      console.log(`📋 ${i + 1}/${propiedadesDuenos.length}: ${property.titulo.substring(0, 40)}...`);
      
      try {
        await page.goto(property.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        
        // Verificar si realmente es dueño directo en la página de detalle
        const esRealmenteDueno = await page.evaluate(() => {
          const html = document.body.innerHTML.toLowerCase();
          const indicadoresDueno = [
            'dueño directo',
            'propietario',
            'vende dueño',
            'particular',
            'dueña'
          ];
          
          const indicadoresInmobiliaria = [
            'inmobiliaria',
            'real estate',
            'brokers',
            'agente',
            'martillero'
          ];
          
          const esDueno = indicadoresDueno.some(ind => html.includes(ind));
          const esInmobiliaria = indicadoresInmobiliaria.some(ind => html.includes(ind));
          
          return esDueno && !esInmobiliaria;
        });
        
        if (!esRealmenteDueno) {
          console.log(`❌ No es dueño directo, saltando...`);
          continue;
        }
        
        const contactData = await page.evaluate(() => {
          let telefono = null;
          let nombre = 'Dueño directo';
          let descripcion = '';
          
          // Buscar teléfono
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
          
          // Buscar en HTML si no encontró
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
          
          // Buscar nombre específico del dueño
          const nombreSelectors = [
            '[data-qa*="contact"] span',
            '.contact-name',
            '[data-qa*="name"]'
          ];
          
          for (const selector of nombreSelectors) {
            const el = document.querySelector(selector);
            if (el && el.textContent.trim() && !el.textContent.toLowerCase().includes('inmobiliaria')) {
              nombre = el.textContent.trim();
              break;
            }
          }
          
          // Descripción
          const descEl = document.querySelector('[data-qa="POSTING_DESCRIPTION"]');
          if (descEl) descripcion = descEl.textContent.trim().substring(0, 200);
          
          return { telefono, nombre, descripcion };
        });
        
        // Normalizar teléfono
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
          descripcion: contactData.descripcion,
          fuente: 'Argenprop',
          tipo_publicador: 'Dueño Directo',
          fecha_scraping: new Date().toISOString(),
          tiene_telefono: !!telefonoNormalizado,
          estado_extraccion: telefonoNormalizado ? 'EXITOSO' : 'SIN_TELEFONO'
        };
        
        results.push(resultado);
        console.log(`${telefonoNormalizado ? '✅ CON TEL' : '❌ SIN TEL'}: ${contactData.nombre} - ${telefonoNormalizado || 'Sin teléfono'}`);
        
      } catch (error) {
        console.log(`❌ Error: ${error.message}`);
      }
      
      await page.waitForTimeout(1000);
    }
    
    const stats = {
      total: results.length,
      con_telefono: results.filter(r => r.tiene_telefono).length,
      tasa_exito: Math.round((results.filter(r => r.tiene_telefono).length / results.length) * 100),
      tipo_publicador: 'Solo Dueños Directos'
    };
    
    console.log(`🎯 Completado DUEÑOS: ${stats.con_telefono}/${stats.total} (${stats.tasa_exito}%)`);
    
    res.json({
      success: true,
      data: results,
      stats,
      filtro_aplicado: 'Dueños Directos',
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
  console.log(`🚀 Scraper API DUEÑOS DIRECTOS corriendo en puerto ${PORT}`);
});
