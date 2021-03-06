goog.provide('ga_layers_service');

goog.require('ga_definepropertiesforlayer_service');
goog.require('ga_maputils_service');
goog.require('ga_networkstatus_service');
goog.require('ga_permalink_service');
goog.require('ga_stylesfromliterals_service');
goog.require('ga_tilegrid_service');
goog.require('ga_time_service');
goog.require('ga_translation_service');
goog.require('ga_urlutils_service');

(function() {

  var module = angular.module('ga_layers_service', [
    'ga_maputils_service',
    'ga_networkstatus_service',
    'ga_storage_service',
    'ga_stylesfromliterals_service',
    'ga_tilegrid_service',
    'ga_definepropertiesforlayer_service',
    'ga_time_service',
    'ga_urlutils_service',
    'ga_permalink_service',
    'ga_translation_service',
    'pascalprecht.translate'
  ]);

  /**
   * Manage BOD layers
   */
  module.provider('gaLayers', function() {

    this.$get = function($http, $q, $rootScope, $translate, $window,
        gaBrowserSniffer, gaDefinePropertiesForLayer, gaMapUtils,
        gaNetworkStatus, gaStorage, gaTileGrid, gaUrlUtils,
        gaStylesFromLiterals, gaGlobalOptions, gaPermalink,
        gaLang, gaTime, gaStyleFactory) {

      var h2 = function(domainsArray) {
        if (gaBrowserSniffer.h2) {
          // Only Cloudfront supports h2, so only subs > 100
          for (var i = 0; i < domainsArray.length; i++) {
            if (parseInt(domainsArray[i]) > 99) {
              return [domainsArray[i]];
            }
          }
        }
        return domainsArray;
      };

      var geojsonPromises = {};

      var stylePromises = {};

      var Layers = function(wmsUrlTemplate, dfltWmsSubdomains,
          dfltVectorTilesSubdomains,
          wmtsUrl, wmtsLV03PathTemplate, wmtsPathTemplate, wmtsSubdomains,
          terrainTileUrlTemplate, vectorTilesUrlTemplate,
          layersConfigUrlTemplate, legendUrlTemplate) {
        var layers;

        // Returns a unique WMS template url (e.g. //wms{s}.geo.admin.ch)
        var getWmsTpl = function(wmsUrl, wmsParams) {
          var tpl = wmsUrl;
          if (/wms.geo/.test(wmsUrl)) {
            tpl = undefined;
          }
          if (tpl && /(request|service|version)/i.test(tpl)) {
            tpl = gaUrlUtils.remove(tpl, ['request', 'service', 'version'],
                true);
          }
          var url = (tpl || wmsUrlTemplate);
          if (wmsParams) {
            url = gaUrlUtils.append(url, gaUrlUtils.toKeyValue(wmsParams));
          }
          return url;
        };

        // Returns a list of WMS or WMTS servers using a template
        // (e.g. //wms{s}.geo.admin.ch or wmts{s}.geo.admin.ch) and an array of
        // subdomains (e.g. ['', '1', ...]).
        var getImageryUrls = function(tpl, subdomains) {
          var urls = [];
          (subdomains || ['']).forEach(function(subdomain) {
            urls.push(tpl.replace('{s}', subdomain));
          });
          return urls;
        };

        var getWmtsGetTileTpl = function(layer, tileMatrixSet, format) {
          var tpl;
          if (tileMatrixSet === '21781') {
            tpl = wmtsUrl + wmtsLV03PathTemplate;
          } else {
            if (tileMatrixSet === '4326' &&
                  layer === 'ch.swisstopo.swissimage-product') {
              tpl = '//tod{s}.prod.bgdi.ch' + wmtsPathTemplate;
            } else {
              tpl = wmtsUrl + wmtsPathTemplate;
            }
          }
          var url = tpl.replace('{Layer}', layer).replace('{Format}', format);
          if (tileMatrixSet) {
            url = url.replace('{TileMatrixSet}', tileMatrixSet);
          }
          return url;
        };

        var getTerrainTileUrl = function(layer, time) {
          return terrainTileUrlTemplate.
              replace('{Layer}', layer).
              replace('{Time}', time);
        };

        var cpt;
        var getVectorTilesUrl = function(layer, time, subdomains) {
          if (cpt === undefined || cpt >= subdomains.length) {
            cpt = 0;
          }
          return vectorTilesUrlTemplate.
              replace('{s}', subdomains[cpt++]).
              replace('{Layer}', layer).
              replace('{Time}', time);
        };

        var getLayersConfigUrl = function(lang) {
          return layersConfigUrlTemplate.
              replace('{Lang}', lang);
        };

        var getMetaDataUrl = function(layer, lang) {
          return legendUrlTemplate.
              replace('{Layer}', layer).
              replace('{Lang}', lang);
        };

        // Function to remove the blob url from memory.
        var revokeBlob = function() {
          $window.URL.revokeObjectURL(this.src);
          this.removeEventListener('load', revokeBlob);
        };

        // The tile load function which loads tiles from local
        // storage if they exist otherwise try to load the tiles normally.
        var tileLoadFunction = function(imageTile, src) {
          var onSuccess = function(content) {
            if (content && $window.URL && $window.atob) {
              try {
                var blob = gaMapUtils.dataURIToBlob(content);
                imageTile.getImage().addEventListener('load', revokeBlob);
                imageTile.getImage().src = $window.URL.createObjectURL(blob);
              } catch (e) {
                // INVALID_CHAR_ERROR on ie and ios(only jpeg), it's an
                // encoding problem.
                // TODO: fix it
                imageTile.getImage().src = content;
              }
            } else {
              imageTile.getImage().src = (content) || src;
            }
          };
          gaStorage.getTile(gaMapUtils.getTileKey(src)).then(onSuccess);
        };

        // Load layers config
        var lastLangUsed;
        var loadLayersConfig = function(lang) {
          if (lastLangUsed === lang) {
            return;
          }
          lastLangUsed = lang;
          var url = getLayersConfigUrl(lang);
          return $http.get(url, {
            cache: true
          }).then(function(response) {

            // Live modifications for 3d test
            if (response.data) {
              // Test layers opaque setting
              var ids = [
                'ch.swisstopo.swissimage-product',
                'ch.swisstopo.swissimage-product_3d',
                'ch.swisstopo.pixelkarte-farbe',
                'ch.swisstopo.pixelkarte-farbe_3d',
                'ch.swisstopo.pixelkarte-grau',
                'ch.swisstopo.pixelkarte-grau_3d',
                'ch.swisstopo.swisstlm3d-karte-farbe',
                'ch.swisstopo.swisstlm3d-karte-farbe_3d',
                'ch.swisstopo.swisstlm3d-karte-grau',
                'ch.swisstopo.swisstlm3d-karte-grau_3d',
                'ch.swisstopo.pixelkarte-farbe-pk25.noscale',
                'ch.swisstopo.pixelkarte-farbe-pk50.noscale',
                'ch.swisstopo.pixelkarte-farbe-pk100.noscale',
                'ch.swisstopo.pixelkarte-farbe-pk200.noscale',
                'ch.swisstopo.pixelkarte-farbe-pk500.noscale',
                'ch.swisstopo.pixelkarte-farbe-pk1000.noscale'
              ];
              angular.forEach(ids, function(id) {
                if (response.data[id]) {
                  response.data[id].opaque = true;
                }
              });

              // Test shop layers allowing multiple results in tooltip.
              ids = [
                'ch.swisstopo.lubis-luftbilder_farbe',
                'ch.swisstopo.lubis-luftbilder_schwarzweiss',
                'ch.swisstopo.lubis-luftbilder_infrarot',
                'ch.swisstopo.lubis-bildstreifen'
              ];
              angular.forEach(ids, function(id) {
                if (response.data[id]) {
                  response.data[id].shopMulti = true;
                }
              });

              // Terrain
              var lang = gaLang.getNoRm();
              response.data['ch.swisstopo.terrain.3d'] = {
                type: 'terrain',
                serverLayerName: 'ch.swisstopo.terrain.3d',
                timestamps: ['20160115'],
                attribution: 'swisstopo',
                attributionUrl: 'https://www.swisstopo.admin.ch/' + lang +
                    '/home.html'
              };

              // 3D Tileset
              var tileset3d = [
                'ch.swisstopo.swisstlm3d.3d',
                'ch.swisstopo.swissnames3d.3d',
                'ch.swisstopo.vegetation.3d'
              ];
              var tilesetTs = [
                '20170425',
                '20170814',
                '20170630'
              ];
              var tilesetStyle = [
                undefined,
                'labelEnhanced',
                undefined
              ];

              var params = gaPermalink.getParams();
              var pTileset3d = params['tileset3d'];
              var pTilesetTs = params['tilesetTs'];
              tileset3d = pTileset3d ? pTileset3d.split(',') : tileset3d;
              tilesetTs = pTilesetTs ? pTilesetTs.split(',') : tilesetTs;

              tileset3d.forEach(function(tileset3dId, idx) {
                if (tileset3dId) {
                  response.data[tileset3dId.replace('.3d', '_3d')] = {
                    type: 'tileset3d',
                    serverLayerName: tileset3dId,
                    timestamps: [tilesetTs[idx]],
                    attribution: 'swisstopo',
                    attributionUrl: 'https://www.swisstopo.admin.ch/' + lang +
                        '/home.html',
                    style: tilesetStyle[idx],
                    tooltip: false,
                    default3d: true
                  };
                }
              });
              if (response.data['ch.swisstopo.swissnames3d_3d'] &&
                 response.data['ch.swisstopo.swissnames3d']) {
                response.data['ch.swisstopo.swissnames3d'].config3d =
                    'ch.swisstopo.swissnames3d_3d';
              }

              // Set the config2d property
              for (var l in response.data) {
                var data = response.data[l];
                if (response.data.hasOwnProperty(l) && data.config3d) {
                  response.data[data.config3d].config2d = l;
                }
              }
            }

            if (!layers) { // First load
              layers = response.data;
              // We register events only when layers are loaded
              $rootScope.$on('$translateChangeEnd', function(event, newLang) {
                loadLayersConfig(newLang.language);
              });

            } else { // Only translations has changed
              layers = response.data;
              $rootScope.$broadcast('gaLayersTranslationChange', layers);
            }
            return layers;
          });
        };

        // Load layers configuration with value from permalink
        // gaLang.get() never returns an undefined value on page load.
        var configP = loadLayersConfig(gaLang.get());

        /**
         * Get the promise of the layers config requets
         */
        this.loadConfig = function() {
          return configP;
        };

        /**
         * Returns an Cesium terrain provider.
         */
        this.getCesiumTerrainProviderById = function(bodId) {
          var config3d = this.getConfig3d(layers[bodId]);
          if (!/^terrain$/.test(config3d.type)) {
            return;
          }
          var timestamp = this.getLayerTimestampFromYear(config3d,
              gaTime.get());
          var requestedLayer = config3d.serverLayerName || bodId;
          var provider = new Cesium.CesiumTerrainProvider({
            url: getTerrainTileUrl(requestedLayer, timestamp),
            availableLevels: gaGlobalOptions.terrainAvailableLevels,
            rectangle: gaMapUtils.extentToRectangle(
                gaGlobalOptions.defaultExtent)
          });
          provider.bodId = bodId;
          return provider;
        };

        /**
         * Returns an Cesium 3D Tileset.
         */
        this.getCesiumTileset3dById = function(bodId) {
          var config3d = this.getConfig3d(layers[bodId]);
          if (!/^tileset3d$/.test(config3d.type)) {
            return;
          }
          var timestamp = this.getLayerTimestampFromYear(config3d,
              gaTime.get());
          var requestedLayer = config3d.serverLayerName || bodId;
          var tileset = new Cesium.Cesium3DTileset({
            url: getVectorTilesUrl(requestedLayer, timestamp,
                h2(dfltVectorTilesSubdomains)),
            maximumNumberOfLoadedTiles: 3
          });
          tileset.bodId = bodId;
          if (config3d.style) {
            var style = gaStyleFactory.getStyle(config3d.style);
            tileset.style = new Cesium.Cesium3DTileStyle(style);
          }
          return tileset;
        };

        /**
         * Returns an Cesium imagery provider.
         */
        this.getCesiumImageryProviderById = function(bodId, olLayer) {
          var config = layers[bodId];
          var config3d = this.getConfig3d(config);
          if (!/^(wms|wmts|aggregate)$/.test(config3d.type)) {
            // In case, the 2d layer is a layer group we return an empty array
            // otherwise the GaRasterSynchroniser will go through the children
            // then display them in 3d. Another synchronizer will take care to
            // display the good cesium layer for this group.
            if (/^aggregate$/.test(config.type)) {
              return [];
            }
            return;
          }
          var params;
          bodId = config.config3d || bodId;
          var requestedLayer = config3d.wmsLayers || config3d.serverLayerName ||
              bodId;
          var format = config3d.format || 'png';
          // pngjpeg not supported by Cesium (zeitreihen)
          if (format === 'pngjpeg') {
            format = 'jpeg';
          }
          if (config3d.type === 'aggregate') {
            var providers = [];
            config3d.subLayersIds.forEach(function(item) {
              var subProvider = this.getCesiumImageryProviderById(item,
                  olLayer);
              if (Array.isArray(subProvider) && subProvider.length) {
                providers.push.apply(providers, subProvider);
              } else if (subProvider) {
                providers.push(subProvider);
              }
            }, this);
            return providers;
          }
          if (config3d.type === 'wmts') {
            params = {
              url: getWmtsGetTileTpl(requestedLayer, '4326', format),
              tileSize: 256,
              subdomains: h2(wmtsSubdomains)
            };
          } else if (config3d.type === 'wms') {
            var tileSize = 512;
            var wmsParams = {
              layers: requestedLayer,
              format: 'image/' + format,
              service: 'WMS',
              version: '1.3.0',
              request: 'GetMap',
              crs: 'CRS:84',
              bbox: '{westProjected},{southProjected},' +
                    '{eastProjected},{northProjected}',
              width: tileSize,
              height: tileSize,
              styles: ''
            };
            if (config3d.timeEnabled) {
              wmsParams.time = '{Time}';
            }
            params = {
              url: getWmsTpl(gaGlobalOptions.wmsUrl, wmsParams),
              tileSize: tileSize,
              subdomains: dfltWmsSubdomains
            };
          }
          var extent = config3d.extent || gaMapUtils.defaultExtent;
          if (params) {
            var minRetLod = gaMapUtils.getLodFromRes(config3d.maxResolution) ||
                gaGlobalOptions.minimumRetrievingLevel;
            var maxRetLod = gaMapUtils.getLodFromRes(config3d.minResolution);
            // Set maxLod as undefined deactivate client zoom.
            var maxLod = (maxRetLod) ? undefined : 18;
            if (maxLod && config3d.resolutions) {
              maxLod = gaMapUtils.getLodFromRes(
                  config3d.resolutions[config3d.resolutions.length - 1]);
            }
            params.customTags = {
              Time: function() {
                return olLayer.time || '';
              }
            };
            var provider = new Cesium.UrlTemplateImageryProvider({
              url: params.url,
              subdomains: params.subdomains,
              minimumLevel: minRetLod,
              maximumRetrievingLevel: maxRetLod,
              // This property active client zoom for next levels.
              maximumLevel: maxLod,
              rectangle: gaMapUtils.extentToRectangle(extent),
              tilingScheme: new Cesium.GeographicTilingScheme(),
              tileWidth: params.tileSize,
              tileHeight: params.tileSize,
              hasAlphaChannel: (format === 'png'),
              availableLevels: gaGlobalOptions.imageryAvailableLevels,
              // Experimental: restrict all rasters from 0 - 17 to terrain
              // availability and 18 to Swiss bbox
              metadataUrl: gaGlobalOptions.imageryMetadataUrl,
              customTags: params.customTags
            });
            provider.bodId = bodId;
            return provider;
          }
        };

        /**
         * Returns a promise of Cesium DataSource.
         */
        this.getCesiumDataSourceById = function(bodId, scene) {
          var config = layers[bodId];
          bodId = config.config3d;
          var config3d = this.getConfig3d(config);
          if (!/^kml$/.test(config3d.type)) {
            return;
          }
          var dsP = Cesium.KmlDataSource.load(config3d.url, {
            camera: scene.camera,
            canvas: scene.canvas,
            proxy: gaUrlUtils.getCesiumProxy()
          });
          return dsP;
        };

        /**
         * Return an ol.layer.Layer object for a layer id.
         */
        this.getOlLayerById = function(bodId, opts) {
          var config = layers[bodId];
          var olLayer;
          var timestamp = this.getLayerTimestampFromYear(bodId, gaTime.get());
          var crossOrigin = 'anonymous';
          var extent = config.extent || gaMapUtils.defaultExtent;

          // For some obscure reasons, on iOS, displaying a base 64 image
          // in a tile with an existing crossOrigin attribute generates
          // CORS errors.
          // Currently crossOrigin definition is only used for mouse cursor
          // detection on desktop in TooltipDirective.
          if (gaBrowserSniffer.ios) {
            crossOrigin = undefined;
          }

          // We allow duplication of source for time enabled layers
          var olSource = (config.timeEnabled) ? null : config.olSource;
          if (config.type === 'wmts') {
            if (!olSource) {
              var tileMatrixSet = gaGlobalOptions.defaultEpsg.split(':')[1];
              var wmtsTplUrl = getWmtsGetTileTpl(config.serverLayerName,
                  tileMatrixSet, config.format).
                  replace('{z}', '{TileMatrix}').
                  replace('{x}', '{TileCol}').
                  replace('{y}', '{TileRow}');
              olSource = config.olSource = new ol.source.WMTS({
                dimensions: {
                  'Time': timestamp
                },
                // Workaround: Set a cache size of zero when layer is
                // timeEnabled see:
                // https://github.com/geoadmin/mf-geoadmin3/issues/3491
                cacheSize: config.timeEnabled ? 0 : 2048,
                layer: config.serverLayerName,
                format: config.format,
                projection: gaGlobalOptions.defaultEpsg,
                requestEncoding: 'REST',
                tileGrid: gaTileGrid.get(config.resolutions,
                    config.minResolution),
                tileLoadFunction: tileLoadFunction,
                urls: getImageryUrls(wmtsTplUrl, h2(wmtsSubdomains)),
                crossOrigin: crossOrigin,
                transition: 0
              });
            }
            olLayer = new ol.layer.Tile({
              minResolution: gaNetworkStatus.offline ? null :
                config.minResolution,
              maxResolution: config.maxResolution,
              opacity: config.opacity || 1,
              source: olSource,
              extent: extent,
              preload: gaNetworkStatus.offline ? gaMapUtils.preload : 0,
              useInterimTilesOnError: gaNetworkStatus.offline
            });
          } else if (config.type === 'wms') {
            var wmsParams = {
              LAYERS: config.wmsLayers,
              FORMAT: 'image/' + config.format,
              LANG: gaLang.get()
            };
            if (config.singleTile === true) {
              if (!olSource) {
                olSource = config.olSource = new ol.source.ImageWMS({
                  url: getImageryUrls(getWmsTpl(gaGlobalOptions.wmsUrl))[0],
                  params: wmsParams,
                  crossOrigin: crossOrigin,
                  ratio: 1
                });
              }
              olLayer = new ol.layer.Image({
                minResolution: config.minResolution,
                maxResolution: config.maxResolution,
                opacity: config.opacity || 1,
                source: olSource,
                extent: extent
              });
            } else {
              if (!olSource) {
                var subdomains = dfltWmsSubdomains;
                olSource = config.olSource = new ol.source.TileWMS({
                  urls: getImageryUrls(
                      getWmsTpl(gaGlobalOptions.wmsUrl), subdomains),
                  // Temporary until https://github.com/openlayers/ol3/pull/4964
                  // is merged upstream
                  cacheSize: 2048 * 3,
                  params: wmsParams,
                  gutter: config.gutter || 0,
                  crossOrigin: crossOrigin,
                  tileGrid: gaTileGrid.get(config.resolutions,
                      config.minResolution, config.type),
                  tileLoadFunction: tileLoadFunction,
                  wrapX: false,
                  transition: 0
                });
              }
              olLayer = new ol.layer.Tile({
                minResolution: config.minResolution,
                maxResolution: config.maxResolution,
                opacity: config.opacity || 1,
                source: olSource,
                extent: extent,
                preload: gaNetworkStatus.offline ? gaMapUtils.preload : 0,
                useInterimTilesOnError: gaNetworkStatus.offline
              });
            }
          } else if (config.type === 'aggregate') {
            var subLayersIds = config.subLayersIds;
            var i, len = subLayersIds.length;
            var subLayers = new Array(len);
            for (i = 0; i < len; i++) {
              subLayers[i] = this.getOlLayerById(subLayersIds[i]);
            }
            olLayer = new ol.layer.Group({
              minResolution: config.minResolution,
              maxResolution: config.maxResolution,
              opacity: config.opacity || 1,
              layers: subLayers
            });
          } else if (config.type === 'geojson') {
            // cannot request resources over https in S3
            olSource = new ol.source.Vector({
              format: new ol.format.GeoJSON()
            });
            olLayer = new ol.layer.Vector({
              minResolution: config.minResolution,
              maxResolution: config.maxResolution,
              source: olSource,
              extent: extent
            });
            geojsonPromises[bodId] = gaUrlUtils.proxifyUrl(config.geojsonUrl).
                then(function(proxyUrl) {
                  return $http.get(proxyUrl).then(function(response) {
                    var data = response.data;
                    var features = olSource.getFormat().readFeatures(data, {
                      featureProjection: gaGlobalOptions.defaultEpsg
                    });
                    olSource.clear();
                    olSource.addFeatures(features);
                    if (data.timestamp) {
                      olLayer.timestamps = [data.timestamp];
                    }
                    return olSource.getFeatures();
                  });
                });
            var styleUrl;
            if (opts && opts.externalStyleUrl &&
                gaUrlUtils.isValid(opts.externalStyleUrl)) {
              styleUrl = opts.externalStyleUrl;
            } else {
              styleUrl = $window.location.protocol + config.styleUrl;
            }
            // IE doesn't understand agnostic URLs
            stylePromises[bodId] = gaUrlUtils.proxifyUrl(styleUrl).
                then(function(proxyStyleUrl) {
                  return $http.get(proxyStyleUrl, {
                    cache: styleUrl === proxyStyleUrl
                  }).then(function(response) {
                    var olStyleForVector = gaStylesFromLiterals(response.data);
                    olLayer.setStyle(function(feature, res) {
                      return [olStyleForVector.getFeatureStyle(feature, res)];
                    });
                    return olStyleForVector;
                  });
                });
          }
          if (angular.isDefined(olLayer)) {
            gaDefinePropertiesForLayer(olLayer);
            olLayer.bodId = bodId;
            olLayer.label = config.label;
            olLayer.time = timestamp;
            olLayer.timeEnabled = config.timeEnabled;
            olLayer.timeBehaviour = config.timeBehaviour;
            olLayer.timestamps = config.timestamps;
            olLayer.geojsonUrl = config.geojsonUrl;
            olLayer.updateDelay = config.updateDelay;
            olLayer.externalStyleUrl = opts && opts.externalStyleUrl ?
              opts.externalStyleUrl : null;
            olLayer.useThirdPartyData = !(!opts) && !(!opts.externalStyleUrl);
            var that = this;
            olLayer.getCesiumImageryProvider = function() {
              return that.getCesiumImageryProviderById(bodId, olLayer);
            };
            olLayer.getCesiumDataSource = function(scene) {
              return that.getCesiumDataSourceById(bodId, scene);
            };
            olLayer.getCesiumTileset3d = function(scene) {
              return that.getCesiumTileset3dById(bodId, scene);
            };
          }
          return olLayer;
        };

        this.getLayerStylePromise = function(bodId) {
          return stylePromises[bodId];
        };

        // Returns promise of layer with its features when layers are added.
        this.getLayerPromise = function(bodId) {
          return geojsonPromises[bodId];
        };

        /**
         * Returns layers definition for given bodId. Returns
         * undefined if bodId does not exist
         */
        this.getLayer = function(bodId) {
          return layers[bodId];
        };

        this.getConfig3d = function(config) {
          if (config.config3d) {
            return layers[config.config3d];
          }
          return config;
        };

        /**
         * Returns a property of the layer with the given bodId.
         * Note: this throws an exception if the bodId does not
         * exist in currently loaded topic/layers
         */
        this.getLayerProperty = function(bodId, prop) {
          return layers[bodId][prop];
        };

        /**
         * Get Metadata of given layer bodId
         * Uses current topic and language
         * Returns a promise. Use accordingly
         */
        this.getMetaDataOfLayer = function(bodId) {
          var url = getMetaDataUrl(bodId, gaLang.get());
          return $http.get(url);
        };

        /**
         * Find the correct timestamp of layer from a specific year string.
         *
         * Returns undefined if the layer has no timestamp.
         * Returns undefined if the layer has not a timestamp for this year.
         * If there is more than one timestamp for a year we choose the first
         * found.
         */
        this.getLayerTimestampFromYear = function(configOrBodId, yearStr) {
          var config = angular.isString(configOrBodId) ?
            this.getLayer(configOrBodId) : configOrBodId;
          if (!config.timeEnabled) {
            // a WMTS/Terrain/Tileset3d layer has at least one timestamp
            return (config.type === 'wmts' || config.type === 'terrain' ||
                config.type === 'tileset3d') ? config.timestamps[0] : undefined;
          }
          var timestamps = config.timestamps || [];
          if (angular.isNumber(yearStr)) {
            yearStr = '' + yearStr;
          }
          if (!angular.isDefined(yearStr)) {
            var timeBehaviour = config.timeBehaviour;
            // check if specific 4/6/8 digit timestamp is specified
            if (/^\d{4}$|^\d{6}$|^\d{8}$/.test(timeBehaviour)) {
              yearStr = timeBehaviour.substr(0, 4);
            } else if (timeBehaviour !== 'all' && timestamps.length) {
              yearStr = timestamps[0];
            }
          }

          for (var i = 0, ii = timestamps.length; i < ii; i++) {
            var ts = timestamps[i];
            // Strange if statement here because yearStr can either be
            // full timestamp string or year-only string...
            if (yearStr === ts ||
                parseInt(yearStr) === parseInt(ts.substr(0, 4))) {
              return ts;
            }
          }

          return undefined;
        };

        /**
         * Determines if the layer is a bod layer.
         * @param {ol.layer.Base} an ol layer.
         *
         * Returns true if the layer is a BOD layer.
         * Returns false if the layer is not a BOD layer.
         */
        this.isBodLayer = function(olLayer) {
          if (olLayer) {
            var bodId = olLayer.bodId;
            return layers.hasOwnProperty(bodId);
          }
          return false;
        };

        /**
         * Determines if the bod layer has a tooltip.
         * Note: the layer is considered to have a tooltip if the parent layer
         * has a tooltip.
         * @param {ol.layer.Base} an ol layer.
         *
         * Returns true if the layer has bod a tooltip.
         * Returns false if the layer doesn't have a bod tooltip.
         */
        this.hasTooltipBodLayer = function(olLayer, is3dActive) {
          if (!olLayer) {
            return false;
          }
          var config = this.getLayer(olLayer.bodId);
          if (!config) {
            return false;
          }
          // We test the config 3d when 3d is enabled
          if (is3dActive) {
            config = this.getConfig3d(config) || config;
          }
          // If the layer's config has no tooltip property we try to get the
          // value from the parent.
          if (!angular.isDefined(config.tooltip) && config.parentLayerId) {
            config = this.getLayer(config.parentLayerId);
          }
          return !!config.tooltip;
        };
      };

      return new Layers(this.wmsUrlTemplate, this.dfltWmsSubdomains,
          this.dfltVectorTilesSubdomains,
          this.wmtsUrl, this.wmtsLV03PathTemplate, this.wmtsPathTemplate,
          this.wmtsSubdomains, this.terrainTileUrlTemplate,
          this.vectorTilesUrlTemplate, this.layersConfigUrlTemplate,
          this.legendUrlTemplate);
    };
  });

  /**
   * Service provides different kinds of filter for
   * layers in the map
   */
  module.provider('gaLayerFilters', function() {
    this.$get = function(gaLayers, gaMapUtils) {
      return {
        /**
         * Filters out background layers, preview
         * layers, draw, measure.
         * In other words, all layers that
         * were actively added by the user and that
         * appear in the layer manager
         */
        selected: function(layer) {
          return layer.displayInLayerManager;
        },
        selectedAndVisible: function(layer) {
          return layer.displayInLayerManager && layer.visible;
        },
        permalinked: function(layer) {
          return layer.displayInLayerManager && !!layer.id &&
                 !gaMapUtils.isLocalKmlLayer(layer) &&
                 !gaMapUtils.isLocalGpxLayer(layer);
        },
        /**
         * Keep only time enabled layer
         */
        timeEnabled: function(layer) {
          return layer.timeEnabled &&
                 layer.visible &&
                 !layer.background &&
                 !layer.preview;
        },
        /**
         * Keep layers with potential tooltip for query tool
         */
        potentialTooltip: function(layer) {
          return !!(layer.displayInLayerManager &&
                 layer.visible &&
                 layer.bodId &&
                 gaLayers.hasTooltipBodLayer(layer) &&
                 !gaMapUtils.isVectorLayer(layer));
        },
        /**
         * Searchable layers
         */
        searchable: function(layer) {
          return !!(layer.displayInLayerManager &&
                 layer.visible &&
                 layer.bodId &&
                 gaLayers.getLayerProperty(layer.bodId, 'searchable'));
        },
        /**
         * Queryable layers (layers with queryable attributes)
         */
        queryable: function(layer) {
          return !!(layer.displayInLayerManager &&
                 layer.visible &&
                 layer.bodId &&
                 gaLayers.getLayerProperty(layer.bodId,
                     'queryableAttributes') &&
                 gaLayers.getLayerProperty(layer.bodId,
                     'queryableAttributes').length);
        },
        /**
         * Keep only background layers
         */
        background: function(layer) {
          return layer.background;
        },
        /**
         * "Real-time" layers (only geojson layers for now)
         */
        realtime: function(layer) {
          return layer.updateDelay != null;
        }
      };
    };
  });
})();
