-- OSRM car profile with Philippine speed limits, used for every drive time in Project AGA.
-- It loads OSRM's stock car profile and replaces only the speeds:
--   motorway (expressways: NLEX, SLEX, SCTEX ...)     100 km/h  expressway limit
--   trunk, primary (national roads)                     80 km/h  RA 4136 Sec. 35: open country roads
--   secondary, tertiary, all ramps                      40 km/h  RA 4136: through streets
--   unclassified, residential                           30 km/h  RA 4136: city and municipal streets
--   living_street, service                              20 km/h  RA 4136: crowded streets
-- Roads with a posted limit tagged in OpenStreetMap (maxspeed) use that limit as is (no 20% reduction).
-- Ferries keep their scheduled crossing times. Build with scripts/osrm-prepare.sh.
api_version = 4

package.path = '/opt/?.lua;' .. package.path
local car = dofile('/opt/car.lua')
local stock_setup = car.setup

car.setup = function()
  local p = stock_setup()
  p.speeds = Sequence {
    highway = {
      motorway       = 100,
      motorway_link  = 40,
      trunk          = 80,
      trunk_link     = 40,
      primary        = 80,
      primary_link   = 40,
      secondary      = 40,
      secondary_link = 40,
      tertiary       = 40,
      tertiary_link  = 40,
      unclassified   = 30,
      residential    = 30,
      living_street  = 20,
      service        = 20,
    }
  }
  p.speed_reduction = 1.0
  return p
end

return car
