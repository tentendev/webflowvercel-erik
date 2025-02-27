const { join } = require(`path`)
const globby = require(`globby`)
const cheerio = require(`cheerio`)
const { readFile, outputFile } = require(`fs-extra`)
const posthtml = require(`posthtml`)
const posthtmlWebp = require(`posthtml-webp`)
const webp = require(`webp-converter`)
const postcss = require('postcss')
const postcssWebp = require(`webp-in-css/plugin`)
const { exists } = require('fs-extra')
const inlineCriticalCss = require(`netlify-plugin-inline-critical-css`).onPostBuild
const imageOptim = require(`netlify-plugin-image-optim`).onPostBuild

webp.grant_permission()
let origin = process.env.WEBFLOW_URL
if(origin[origin.length - 1] !== `/`) {
	origin += `/`
}

function toBool(str){
	const type = typeof str
	if(type === `boolean`) {
		return str
	}
	if(type === `string`) {
		if(
			str === `true` ||
			str === `yes` ||
			str === `on` ||
			str === `1`
		) {
			return true
		}
		return false
	}
	return !!str
}

// Check for feature flags
let useWebp = toBool(process.env.WEBP)
let inlineCss = toBool(process.env.INLINE_CSS)
let replaceRobotsTxt = toBool(process.env.REPLACE_ROBOTS_TXT)

module.exports = function webflowPlugin(){
	let excludeFromSitemap = []

	return function(){

		// Parse CSS for webp images
		if(useWebp){
			this.on(`parseCss`, async ({ data }) => {
				const result = await postcss([postcssWebp({
					rename: oldName => {
						// Extracts url from CSS string background image
						const oldUrl = oldName.match(/url\(['"]?([^'"]+)['"]?\)/)[1]
						const newUrl = `${oldUrl}.webp`
						const newName = oldName.replace(oldUrl, newUrl)
						return newName
					}
				})])``
					 .process(data, { from: undefined })
				return result.css
			})
		}

		this.on(`parseHtml`, ({ $, url }) => {
			const $body = $(`body`)
			const $head = $(`head`)
			const $html = $(`html`)

			// Add lang attrbute
			if(!$html.attr(`lang`)){
				$html.attr(`lang`, `en`)
			}

			// Polyfill for webp
			if(useWebp){
				$body.append(`<script>document.body.classList.remove('no-js');var i=new Image;i.onload=i.onerror=function(){document.body.classList.add(i.height==1?"webp":"no-webp")};i.src="data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";</script>`)
			}

			// Removes the "Powered by Webflow" link for paid accounts
			$html.removeAttr(`data-wf-domain`)

			// Remove generator meta tag
			$head.find(`meta[name="generator"]`).remove()

			// Add CryoLayer generator meta tag
			$head.append(`<meta name="generator" content="CryoLayer" />`)

			// Make webfonts.js async
			// let webfontsJs = `{}`
			// let webfontsSrc = ``
			// $(`script`).each((i, el) => {
			// 	const $el = $(el)
			// 	const src = $el.attr(`src`)
			// 	const contents = get(el, `children.0.data`, ``)
			// 	if (
			// 		src &&
			// 		src.indexOf(`googleapis.com`) > -1 &&
			// 		src.indexOf(`webfont.js`) > -1
			// 	) {
			// 		webfontsSrc = src
			// 		$el.remove()
			// 	}
			// 	if(contents && contents.indexOf(`WebFont.load({`) === 0){
			// 		webfontsJs = contents.replace(`WebFont.load(`, ``).replace(`);`, ``)
			// 		$el.remove()
			// 	}
			// })
			// $head.append(`<script>WebFontConfig=${webfontsJs},function(e){var o=e.createElement("script"),t=e.scripts[0];o.src="${webfontsSrc}",o.async=!0,t.parentNode.insertBefore(o,t)}(document);</script>`)

			// Fix cross-origin links
			$(`a`).each((i, el) => {
				const $el = $(el)
				const href = $el.attr(`href`)
				if(href){
					if (href.indexOf(`://`) > -1) {
						$el.attr(`rel`, `noopener noreferrer`)
					}
					// Make internal links external
					if (!process.env.BCP) {
						$el.attr(`href`, `${origin}${href.replace(`/`, ``)}`)
					}
				}
			})

			// Find links to remove from sitemap
			let includeInSitemap = $body.attr(`sitemap`)
			if(includeInSitemap){
				$body.removeAttr(`sitemap`)
			}
			if(includeInSitemap === `false` || includeInSitemap === `0` || includeInSitemap === `no`){
				includeInSitemap = false
			}
			else{
				includeInSitemap = true
			}
			if(!includeInSitemap){
				excludeFromSitemap.push(url)
			}


		})

		// Need to output as `{{name}}.html` instead of `index.html` for pretty URLs
		this.on(`writeFile`, async obj => {
			const dist = this.dist
			let { outputPath } = obj

			// Split path into parts
			const parts = outputPath.replace(dist, ``).split(`/`)
			const name = parts.pop()
			const dir = parts.pop()
			if(name === `index.html` && dir){
				obj.outputPath = dist + parts.join(`/`) + `/` + dir + `.html`
			}
		})

		this.on(`complete`, async () => {
			const dist = this.dist
			const PUBLISH_DIR = join(process.cwd(), dist)

			// Inline critical CSS
			if(inlineCss){
				console.log(`Inlining critical CSS...`)
				await inlineCriticalCss({
					inputs: {
						fileFilter: ['*.html'],
						directoryFilter: ['!node_modules'],
						minify: true,
						extract: true,
						dimensions: [
							{
								width: 414,
								height: 896,
							},
							{
								width: 1920,
								height: 1080,
							},
						],
					},
					constants: {
						PUBLISH_DIR,
					},
					utils: {
						build: {
							failBuild: (msg, { error }) => {
								console.error(msg)
								console.error(error)
								// process.exit(1)
							},
						},
					},
				}).catch(err => {
					console.log(`ERROR`)
					console.error(err)
				})
			}

			// Optimize images
			console.log(`Optimizing images...`)
			await imageOptim({
				constants: {
					PUBLISH_DIR,
				},
			}).catch((err) => {
				console.error(err)
				// process.exit(1)
			})



			// Create robots.txt if it doesn't exist
			const newRobotsTxt = replaceRobotsTxt || !(await exists(join(dist, `robots.txt`)))
			if (newRobotsTxt) {
				console.log(`Creating robots.txt...`)
				await outputFile(join(dist, `robots.txt`), ``)
			}


			if(useWebp){
				// Add webp support to HTML files
				console.log(`Adding webp support...`)
				const htmlFiles = await globby(`${dist}/**/*.html`)
				for(let file of htmlFiles){
					let html = await readFile(file, `utf8`)
					// Add webp support to image tags
					const result = await posthtml()
						.use(posthtmlWebp({
							extensionIgnore: [`svg`],
						}))
						.process(html)
					html = result.html
					await outputFile(file, html)
				}

				// Create webp images
				console.log(`Creating webp images...`)
				const images = await globby(`${dist}/**/*.{jpg,jpeg,png,gif,JPG,JPEG,PNG,GIF}`)
				for(let file of images){
					const newPath = file + `.webp`
					await webp.cwebp(file, newPath, `-q 90`)
				}
			}



			// Remove excluded pages from sitemap
			excludeFromSitemap = excludeFromSitemap.map(url => {
				url = this.convertUrl(url)
				return url
			})
			const xmlFiles = await globby(join(dist, `**/*.xml`))

			for(let xmlPath of xmlFiles){
				const xmlStr = await readFile(xmlPath, `utf8`)
				const $ = cheerio.load(xmlStr, {
					decodeEntities: false,
					xmlMode: true,
				})
				$(`url`).each((_, el) => {
					const $url = $(el);
					const loc = $url.find(`loc`);
					const link = $url.find(`xhtml\\:link`);
					// Sept. 4, 2023: Update Sitemap URL
					let url = loc.text().trim(); // Use let instead of const

					const webflowUrlWithoutSlash = process.env.WEBFLOW_URL.replace(/\/$/, '');
					console.log('Original URL:', url);
					console.log('WEBFLOW_URL:', process.env.WEBFLOW_URL);
					console.log('Updated URL:', process.env.URL);
					// REPLACE WEBFLOW URL WITH Official URL
					// url = url.replace(process.env.WEBFLOW_URL, process.env.URL);
					// Check if the original URL is equal to the Webflow URL
					if (url === webflowUrlWithoutSlash) {
						// Force update to use the updated URL
						url = process.env.URL;
					} else {
						// Update the URL by replacing the Webflow URL with the updated URL
						url = url.replace(process.env.WEBFLOW_URL, process.env.URL);
					}
					
					console.log('Final URL:', url);
					if (excludeFromSitemap.indexOf(url) > -1) {
					  $url.remove();
					}
					// Update both the <loc> content and the href attribute
					loc.text(url);
					link.attr('href', url);
				});

				
				const additionalUrls = [];

				// Load Collection IDs from Vercel Environment Variable
				const COLLECTION_IDS = process.env.WEBFLOW_COLLECTION_IDS
				    ? process.env.WEBFLOW_COLLECTION_IDS.split(",") // Convert to array
				    : [];
				
				const API_KEY = process.env.WEBFLOW_API_KEY;
				const API_BASE = "https://api.webflow.com/v2/collections/";
				
				// Check if API_KEY, COLLECTION_IDS, and URL are set before running
				if (!API_KEY || !COLLECTION_IDS.length || !process.env.URL) {
				    console.error("Missing required environment variables. Ensure WEBFLOW_API_KEY, WEBFLOW_COLLECTION_IDS, and URL are set.");
				    process.exit(1);
				}

				
				async function fetchBlogPosts() {
				    for (const id of COLLECTION_IDS) {
				        try {
				            const collectionRes = await fetch(`${API_BASE}${id}`, {
				                headers: { "Authorization": `Bearer ${API_KEY}`, "accept-version": "2.0.0" }
				            });
				            const collectionData = await collectionRes.json();
				            const collectionSlug = collectionData.slug || "unknown-collection";
				
				            const res = await fetch(`${API_BASE}${id}/items`, {
				                headers: { "Authorization": `Bearer ${API_KEY}`, "accept-version": "2.0.0" }
				            });
				            const data = await res.json();
				
				            data.items?.forEach(item => {
				                const slug = item.fieldData?.slug;
				                if (slug) additionalUrls.push(`${process.env.URL}${collectionSlug}/${slug}`);
				            });
				
				        } catch (error) {
				            console.error(`Error fetching collection ${id}:`, error);
				        }
				    }
				    console.log("✅ All Blog URLs:", additionalUrls);
				}
				
				// Run the function
				await fetchBlogPosts();




				// Add additional URLs to the sitemap
				additionalUrls.forEach(url => {
					const $urlNode = $(`<url></url>`);
					$urlNode.append(`<loc>${url}</loc>`);
					$('urlset').append($urlNode);
				});

				const newXml = $.xml();
				console.log(`Writing updated Sitemap with all URLs...`);
				await outputFile(xmlPath, newXml);
			}


			// Write redirects file
			let origin = process.env.WEBFLOW_URL
			while(origin[origin.length - 1] === `/`){
				origin = origin.substring(0, origin.length - 1)
			}
			if(process.env.VERCEL){
				const template = await readFile(join(__dirname, `vercel.json.template`), `utf8`)
				let redirectsData = template.replace(/{{domain}}/g, origin)
				await outputFile(join(dist, `vercel.json`), redirectsData)
			}
			else{
				const template = await readFile(join(__dirname, `_redirects.template`), `utf8`)
				let redirectsData = template.replace(/{{domain}}/g, origin)
				await outputFile(join(dist, `_redirects`), redirectsData)
			}

		})
	}
}
