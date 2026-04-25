/** @type {import('@ohif/app').AppConfig} */
window.config = {
  routerBasename: '/',
  showStudyList: true,
  // DICOMweb data sources — connect to Orthanc
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'Ron Healthcare PACS',
      configuration: {
        friendlyName: 'Ron Healthcare PACS (Orthanc)',
        name: 'orthanc',
        wadoUriRoot: '/orthanc/wado',
        qidoRoot: '/orthanc/dicom-web',
        wadoRoot: '/orthanc/dicom-web',
        qidoSupportsIncludeField: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: true,
        staticWado: true,
        singlepart: 'bulkdata,video',
        bulkDataURI: {
          enabled: true,
          relativeResolution: 'studies',
        },
        omitQuotationForMultipartRequest: true,
      },
    },
  ],
  defaultDataSourceName: 'orthanc',
  // Hotkeys and UI preferences
  hotkeys: [],
  investigationalUseDialog: {
    option: 'never',
  },
};
