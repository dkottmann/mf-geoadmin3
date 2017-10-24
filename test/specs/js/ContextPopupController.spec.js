/* eslint-disable max-len */
describe('ga_contextpopup_controller', function() {

  describe('GaContextPopupController', function() {

    var elt, scope, parentScope, $compile, $rootScope, $timeout, $httpBackend;

    var loadController = function() {
      parentScope = $rootScope.$new();
      var tpl = '<div ng-controller="GaContextPopupController"></div>';
      elt = $compile(tpl)(parentScope);
      $rootScope.$digest();
      scope = elt.scope();
    };

    var injectServices = function($injector) {
      $compile = $injector.get('$compile');
      $rootScope = $injector.get('$rootScope');
      $timeout = $injector.get('$timeout');
      $httpBackend = $injector.get('$httpBackend');
    };

    beforeEach(function() {
      inject(function($injector) {
        injectServices($injector);
      });
      loadController();
    });

    afterEach(function() {
      $httpBackend.verifyNoOutstandingExpectation();
      $httpBackend.verifyNoOutstandingRequest();
      try {
        $timeout.verifyNoPendingTasks();
      } catch (e) {
        $timeout.flush();
      }
    });

    it('set scope values', function() {
      expect(scope.options.heightUrl).to.be('http://alti.geo.admin.ch/rest/services/height');
      expect(scope.options.qrcodeUrl).to.be('http://api3.geo.admin.ch/qrcodegenerator');
    });
  });
});
